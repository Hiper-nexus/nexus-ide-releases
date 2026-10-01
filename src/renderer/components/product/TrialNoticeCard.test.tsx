/** @vitest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_LICENSE, type LicenseState } from '../../../shared/billing-types';
import { useAccessStore } from '../../state/access-store';
import { TrialNoticeCard } from './TrialNoticeCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400_000;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
const openCheckout = vi.fn();
let current: LicenseState = DEFAULT_LICENSE;

async function render(ui: ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(ui));
  return host;
}

/** O hook relê o Main ao montar; o `get` devolve a mesma licença, para a leitura não desfazer o cenário. */
function setLicense(patch: Partial<LicenseState>) {
  current = { ...DEFAULT_LICENSE, ...patch };
  useAccessStore.setState({ license: current, loading: false, failed: false, canUseApp: true });
}

beforeEach(() => {
  openCheckout.mockReset();
  (window as unknown as { nexus: unknown }).nexus = {
    billing: { get: vi.fn(async () => current), onChanged: vi.fn(() => () => undefined), openCheckout },
  };
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

it('nos últimos dias do teste mostra quanto falta e a ação de assinar', async () => {
  setLicense({ access: 'trial', trialEndsAt: new Date(Date.now() + 2 * DAY - 60_000).toISOString() });
  const container = await render(<TrialNoticeCard />);
  expect(container.textContent).toContain('Faltam 2 dias');
  expect(container.querySelector('[role=status]')?.getAttribute('aria-label')).toMatch(/Seu teste termina/);
  expect(container.querySelector('button')?.textContent).toBe('Assinar');
});

it('com mais de 3 dias, no Pro ou sem data, não aparece nada', async () => {
  for (const patch of [
    { access: 'trial', trialEndsAt: new Date(Date.now() + 9 * DAY).toISOString() },
    { access: 'pro', trialEndsAt: new Date(Date.now() + DAY).toISOString() },
    { access: 'trial', trialEndsAt: null },
  ] as const) {
    setLicense({ ...patch });
    const container = await render(<TrialNoticeCard />);
    expect(container.textContent).toBe('');
    await act(async () => root?.unmount());
    container.remove();
  }
});

it('Assinar abre o checkout Pro no navegador e, se falhar, diz para tentar de novo', async () => {
  setLicense({ access: 'trial', trialEndsAt: new Date(Date.now() + DAY - 60_000).toISOString() });
  openCheckout.mockResolvedValueOnce({ ok: true });
  const container = await render(<TrialNoticeCard />);
  const button = container.querySelector('button')!;
  await act(async () => { button.click(); });
  expect(openCheckout).toHaveBeenCalledWith('pro');
  expect(container.textContent).not.toContain('Não abriu');
  openCheckout.mockResolvedValueOnce({ ok: false, error: 'x' });
  await act(async () => { button.click(); });
  expect(container.textContent).toContain('Não abriu o checkout. Tente de novo.');
  openCheckout.mockRejectedValueOnce(new Error('ipc'));
  await act(async () => { button.click(); });
  expect(container.textContent).toContain('Não abriu o checkout. Tente de novo.');
});
