/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountChoiceReceipt } from '../../shared/account-choice';
import type { PaneModel } from '../../shared/types';

const host = vi.hoisted(() => ({
  sessionId: 'session-a' as string | null,
  listeners: new Set<(paneId: string, sessionId: string | null) => void>(),
}));

vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: vi.fn(),
  wakeHost: vi.fn(),
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => host.sessionId),
  onPaneSessionChange: vi.fn((cb: (paneId: string, sessionId: string | null) => void) => {
    host.listeners.add(cb);
    return () => host.listeners.delete(cb);
  }),
}));
vi.mock('../state/confirm-store', () => ({ askConfirm: vi.fn(async () => true) }));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./CostBadge', () => ({ CostBadge: () => null }));
vi.mock('./DevServerChip', () => ({ DevServerChip: () => null }));
vi.mock('./ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('./CommandBlockMenu', () => ({ CommandBlockMenu: () => null }));
vi.mock('./AgentAvatar', () => ({
  AgentAvatar: () => null,
  resolveAgentCategory: () => undefined,
}));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

import { clearAccountChoiceReceiptCache } from '../lib/account-choice-receipt';
import { PaneToolbar } from './PaneToolbar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const get = vi.fn<(sessionId: string) => Promise<AccountChoiceReceipt | null>>();

const DAY_MS = 86_400_000;
const rule: AccountChoiceReceipt = {
  adapterId: 'claude',
  source: 'headroom-rule',
  account: { label: 'g•••@l•••.com', mode: 'subscription' },
  headroom: { usedPct: 12, window: 'Sessão', resetsAt: Date.now() + 3 * DAY_MS, score: 0.88 },
  alternatives: [
    { label: 'x•••@y•••.com', usedPct: null, window: null, resetsAt: null, skipped: 'cooldown' },
  ],
  decidedAt: Date.now(),
};
const other: AccountChoiceReceipt = {
  ...rule,
  source: 'pinned',
  account: { label: 'p•••@q•••.io', mode: 'subscription' },
  headroom: null,
  alternatives: [],
};

const agentPane: PaneModel = { id: 'p1', kind: 'cli-agent', title: 'Helper', adapterId: 'claude' };

let mounted: Array<{ root: Root; el: HTMLDivElement }> = [];

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

async function mount(pane: PaneModel, focused = true): Promise<{ el: HTMLDivElement; root: Root }> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  await act(async () => root.render(<PaneToolbar pane={pane} isFocused={focused} />));
  await flush();
  return { el, root };
}

function chip(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>('[data-account-chip]');
}

describe('PaneToolbar — chip da conta escolhida', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue(rule);
    host.sessionId = 'session-a';
    host.listeners.clear();
    clearAccountChoiceReceiptCache();
    Object.defineProperty(window, 'nexus', {
      value: { accountChoice: { get } },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    for (const { root, el } of mounted) {
      act(() => root.unmount());
      el.remove();
    }
    mounted = [];
    Reflect.deleteProperty(window, 'nexus');
  });

  it('mostra só o rótulo mascarado, com tooltip e aria-label explicando a escolha', async () => {
    const { el } = await mount(agentPane);
    const node = chip(el);
    expect(node).not.toBeNull();
    expect(node!.textContent).toBe('g•••@l•••.com');
    expect(node!.dataset.accountChip).toBe('headroom-rule');
    // `title` (tooltip nativo): o ::after do data-tip é cortado pelo overflow do toolbar.
    const tip = node!.getAttribute('title')!;
    expect(node!.hasAttribute('data-tip')).toBe(false);
    expect(tip).toContain('Conta escolhida pela regra de folga: 12% usado na janela Sessão (reinicia em ');
    expect(tip).toContain('Alternativas: x•••@y•••.com — em espera.');
    const aria = node!.getAttribute('aria-label')!;
    expect(aria.startsWith('Conta do pane: g•••@l•••.com. Conta escolhida pela regra de folga')).toBe(true);
    expect(aria).toContain(tip);
    expect(get).toHaveBeenCalledWith('session-a');
  });

  it('nunca imprime id, score nem nada fora do recibo mascarado', async () => {
    const { el } = await mount(agentPane);
    const html = el.innerHTML;
    expect(html).not.toContain('0.88');
    expect(html).not.toContain('session-a');
    // Todo "@" do chip vem depois de "•••" (máscara): nenhum e-mail com 2+ letras cruas antes dele.
    expect(html).toContain('@');
    expect(html).not.toMatch(/[A-Za-z0-9._-]{2,}@/);
  });

  it('fallback na ativa ganha tom de alerta e a marca "!"', async () => {
    get.mockResolvedValue({
      ...rule,
      source: 'active-fallback',
      note: 'nenhuma conta livre com credencial para claude',
    });
    const { el } = await mount(agentPane);
    const node = chip(el)!;
    expect(node.className).toContain('toolbar__state--account-warn');
    expect(node.textContent).toBe('!g•••@l•••.com');
    expect(node.getAttribute('title')).toContain('Aviso: nenhuma conta livre com credencial para claude.');
  });

  it('login nativo sem conta mostra "conta nativa"', async () => {
    get.mockResolvedValue({ ...rule, source: 'native', account: null, headroom: null, alternatives: [] });
    const { el } = await mount(agentPane);
    expect(chip(el)!.textContent).toBe('conta nativa');
    expect(chip(el)!.getAttribute('title')).toBe('Login nativo da CLI.');
  });

  it('some quando não há recibo, quando é legado e para pane que não é de agente', async () => {
    get.mockResolvedValue(null);
    expect(chip((await mount(agentPane)).el)).toBeNull();

    get.mockResolvedValue({ ...rule, source: 'legacy', account: null });
    clearAccountChoiceReceiptCache();
    expect(chip((await mount({ ...agentPane, id: 'p2' })).el)).toBeNull();

    get.mockClear();
    get.mockResolvedValue(rule);
    clearAccountChoiceReceiptCache();
    expect(chip((await mount({ id: 'sh', kind: 'shell', title: 'zsh' })).el)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('não pergunta nada enquanto o pane não tem sessão viva', async () => {
    host.sessionId = null;
    const { el } = await mount(agentPane);
    expect(chip(el)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('não busca de novo a cada render, nem ao remontar a mesma sessão', async () => {
    const { el, root } = await mount(agentPane);
    expect(get).toHaveBeenCalledOnce();

    for (const focused of [false, true, false, true]) {
      await act(async () => root.render(<PaneToolbar pane={{ ...agentPane, title: `t${focused}` }} isFocused={focused} />));
      await flush();
    }
    expect(get).toHaveBeenCalledOnce();
    expect(chip(el)!.textContent).toBe('g•••@l•••.com');

    // Remontagem (mover o pane no layout) lê do cache, sem novo IPC.
    const second = await mount(agentPane);
    expect(chip(second.el)!.textContent).toBe('g•••@l•••.com');
    expect(get).toHaveBeenCalledOnce();
  });

  it('troca de sessão limpa o chip, busca o novo recibo uma vez e esquece o antigo', async () => {
    const { el } = await mount(agentPane);
    expect(chip(el)!.textContent).toBe('g•••@l•••.com');

    // Sessão nova (respawn): recibo da anterior não pode aparecer nem por um instante.
    let resolveNext: (value: AccountChoiceReceipt) => void = () => undefined;
    get.mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
    await act(async () => {
      for (const cb of host.listeners) cb('p1', 'session-b');
    });
    expect(chip(el)).toBeNull();

    await act(async () => resolveNext(other));
    await flush();
    expect(chip(el)!.textContent).toBe('p•••@q•••.io');
    expect(chip(el)!.getAttribute('title')).toBe('Conta fixada por quem abriu o pane.');
    expect(get.mock.calls.map(([id]) => id)).toEqual(['session-a', 'session-b']);

    // Sessão encerrada: o chip vai embora e nada é perguntado.
    await act(async () => {
      for (const cb of host.listeners) cb('p1', null);
    });
    expect(chip(el)).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);

    // Evento de outro pane não mexe neste.
    await act(async () => {
      for (const cb of host.listeners) cb('outro-pane', 'session-z');
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('resposta atrasada de uma sessão antiga não pinta o pane da sessão nova', async () => {
    // As DUAS sessões ficam pendentes e a antiga responde primeiro: o recibo dela
    // não pode aparecer no pane que já é da sessão nova (nem por um instante).
    let resolveOld: (value: AccountChoiceReceipt) => void = () => undefined;
    let resolveNew: (value: AccountChoiceReceipt) => void = () => undefined;
    get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    get.mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    const { el } = await mount(agentPane);
    expect(chip(el)).toBeNull();

    await act(async () => {
      for (const cb of host.listeners) cb('p1', 'session-b');
    });
    await act(async () => resolveOld(rule));
    await flush();
    expect(chip(el)).toBeNull();

    await act(async () => resolveNew(other));
    await flush();
    expect(chip(el)!.textContent).toBe('p•••@q•••.io');
    expect(chip(el)!.getAttribute('title')).not.toContain('regra de folga');
  });

  it('sem bridge (ambiente sem preload) o toolbar continua inteira, sem chip', async () => {
    Reflect.deleteProperty(window, 'nexus');
    const { el } = await mount(agentPane);
    expect(chip(el)).toBeNull();
    expect(el.querySelector('.toolbar')).not.toBeNull();
  });
});
