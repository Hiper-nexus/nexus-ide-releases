/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionModelsSection } from './DecisionModelsSection';
import type { DecisionModelStatus } from '../../../shared/decision-models';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const OTHER_ACCOUNT = 'fedcba9876543210fedcba9876543210';
let status: DecisionModelStatus;
let host: HTMLDivElement;
let root: Root;
let storedToken = '';
let rejectedSave = false;
let statusFails = false;

async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<DecisionModelsSection />); });
}
function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function button(label: string) { return [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!; }
function choose(label: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
}
const notices = () => host.querySelector('[aria-label="Avisos dos modelos de decisão"]')?.textContent ?? '';
const orchSet = () => (window.nexus.settings.orchSet as ReturnType<typeof vi.fn>);
const bridge = () => window.nexus.decisionModels as unknown as Record<'status' | 'setKey' | 'test', ReturnType<typeof vi.fn>>;

describe('complementary decision model settings', () => {
  beforeEach(() => {
    storedToken = ''; rejectedSave = false; statusFails = false;
    status = { settings: { mode: 'jev', clefModel: 'clef', cloudflareAccountId: ACCOUNT, visionEnabled: false },
      accountId: ACCOUNT, accountIdSource: 'settings', hasStoredKey: false,
      hasEnv: false, keyMasked: null, secureStorageAvailable: true, isReady: false, jevReady: true, lunaReady: false };
    Object.defineProperty(window, 'nexus', { configurable: true, value: {
      settings: { orchSet: vi.fn(async (patch) => { status = { ...status, settings: patch.decisionModels, accountId: patch.decisionModels.cloudflareAccountId }; return { decisionModels: status.settings }; }) },
      decisionModels: {
        status: vi.fn(async () => { if (statusFails) throw new Error('offline'); return status; }),
        setKey: vi.fn(async ({ token }) => {
          if (rejectedSave) return { ok: false, error: 'Cofre indisponível.' };
          storedToken = token; status = { ...status, hasStoredKey: Boolean(token), keyMasked: token ? 'syn…oken' : null, isReady: Boolean(token) };
          return { ok: true };
        }),
        test: vi.fn(async () => ({ ok: false, detail: 'Token recusado.' })),
      },
    } });
  });
  afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); });

  it('shows manual and automatic options and starts without visual egress', async () => {
    await mount();
    expect(host.textContent).toContain('Automático');
    expect(host.textContent).toContain('Somente Jev');
    expect(host.textContent).toContain('Somente Clef');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Analisar imagens com Clef"]')?.checked).toBe(false);
  });

  it('names the mode and variant controls exactly as they are labelled on screen (WCAG 2.5.3)', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'clef' } };
    await mount();
    const visible = [...host.querySelectorAll('label.settings-field')].map(label => label.firstChild?.textContent?.trim());
    expect(visible).toContain('Escolha do modelo');
    expect(visible).toContain('Variante Cloudflare');
    expect(host.querySelector('select[aria-label="Escolha do modelo"]')).not.toBeNull();
    expect(host.querySelector('select[aria-label="Variante Cloudflare"]')).not.toBeNull();
  });

  it('saves only the Cloudflare token, clears its transient input and never persists plaintext in web storage', async () => {
    await mount();
    await act(async () => { fill('API Token Cloudflare', 'synthetic-private-token'); });
    await act(async () => { button('Salvar token').click(); });
    expect(storedToken).toBe('synthetic-private-token');
    expect(orchSet()).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="API Token Cloudflare"]')?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="API Token Cloudflare"]')?.type).toBe('password');
    expect(JSON.stringify(localStorage)).not.toContain('synthetic-private-token');
    expect(host.textContent).not.toContain('synthetic-private-token');
  });

  it('reports rejected vault writes instead of claiming that the token was saved', async () => {
    rejectedSave = true; await mount();
    await act(async () => { fill('API Token Cloudflare', 'synthetic-private-token'); });
    await act(async () => { button('Salvar token').click(); });
    expect(storedToken).toBe('');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Cofre indisponível');
  });

  it('corrects only the Account ID without pasting the token again', async () => {
    status = { ...status, hasStoredKey: true, keyMasked: 'syn…oken', isReady: true };
    await mount();
    expect(button('Salvar Account ID').disabled).toBe(true);
    await act(async () => { fill('Account ID Cloudflare', OTHER_ACCOUNT); });
    expect(host.textContent).toContain('Account ID ainda não salvo');
    await act(async () => { button('Salvar Account ID').click(); });
    expect(orchSet()).toHaveBeenCalledWith({ decisionModels: expect.objectContaining({ cloudflareAccountId: OTHER_ACCOUNT }) });
    expect(bridge().setKey).not.toHaveBeenCalled();
    expect(status.hasStoredKey).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Account ID salvo');
  });

  it('rejects an invalid Account ID inline, marks the field and links it to the message', async () => {
    await mount();
    await act(async () => { fill('Account ID Cloudflare', 'invalid'); });
    await act(async () => { button('Salvar Account ID').click(); });
    expect(orchSet()).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Account ID');
    const input = host.querySelector('input[aria-label="Account ID Cloudflare"]')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    await act(async () => { fill('Account ID Cloudflare', OTHER_ACCOUNT); });
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('removes only the Cloudflare token', async () => {
    status = { ...status, hasStoredKey: true, keyMasked: 'syn…oken', isReady: true };
    await mount();
    await act(async () => { button('Remover token').click(); });
    expect(bridge().setKey).toHaveBeenCalledTimes(1);
    expect(bridge().setKey).toHaveBeenCalledWith({ token: '' });
    expect(status.hasStoredKey).toBe(false);
    expect(host.textContent).toContain('Token Cloudflare removido');
  });

  it('persists explicit automatic mode through validated settings', async () => {
    await mount();
    await act(async () => { choose('Escolha do modelo', 'auto'); });
    expect(status.settings.mode).toBe('auto');
    expect(status.settings.visionEnabled).toBe(false);
  });

  it('switches the Clef variant in Clef-only mode', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'clef' } };
    await mount();
    await act(async () => { choose('Variante Cloudflare', 'clef-flash'); });
    expect(status.settings).toMatchObject({ mode: 'clef', clefModel: 'clef-flash' });
  });

  it('offers Clef-omni with its capabilities and price, and describes the Flash 24k context', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'clef' } };
    await mount();
    const options = [...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Variante Cloudflare"] option')];
    expect(options.find(option => option.value === 'clef-omni')?.textContent).toBe('Clef-omni — texto, imagem e áudio; US$ 0,15/M');
    expect(options.find(option => option.value === 'clef-flash')?.textContent).toContain('US$ 0,038/M');
    expect(host.textContent).toContain('o Flash até 24.576');
    expect(host.querySelector('input[aria-label="Confirmar ativação por voz com Clef-omni"]')).toBeNull();
    await act(async () => { choose('Variante Cloudflare', 'clef-omni'); });
    expect(status.settings).toMatchObject({ mode: 'clef', clefModel: 'clef-omni' });
    expect(status.settings).not.toHaveProperty('audioConsent');
  });

  it('asks a separate confirmation before sending voice clips and turns it off at once', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'clef', clefModel: 'clef-omni', visionEnabled: true }, isReady: true, hasStoredKey: true };
    await mount();
    const audio = () => host.querySelector<HTMLInputElement>('input[aria-label="Confirmar ativação por voz com Clef-omni"]')!;
    expect(audio().checked).toBe(false);
    await act(async () => { audio().click(); });
    expect(orchSet()).not.toHaveBeenCalled();
    const consent = host.querySelector('[aria-label="Confirmar envio de áudio"]')?.textContent ?? '';
    // Diz exatamente o que sai: ~2 s até a detecção de "Hey Jarvis", inclusive o ambiente num falso positivo.
    for (const fact of ['Cloudflare', '“Hey Jarvis”', 'cerca de 2 segundos', 'terminam nesse instante', 'logo antes',
      'sem uma detecção local', 'token da Cloudflare', 'som ambiente ou a conversa', 'até cerca de 1,5 s']) expect(consent).toContain(fact);
    for (const claim of ['transcreve', 'depois de você dizer', 'conversas e gravações longas não vão']) expect(consent).not.toContain(claim);
    await act(async () => { button('Ativar envio de áudio').click(); });
    expect(status.settings).toMatchObject({ visionEnabled: true, audioConsent: { version: 1, recipients: ['clef'] } });
    expect(audio().checked).toBe(true);
    orchSet().mockClear();
    await act(async () => { audio().click(); });
    expect(orchSet()).toHaveBeenCalledTimes(1);
    expect(status.settings).toMatchObject({ audioConsent: { version: 1, recipients: [] } });
  });

  it('asks for a fresh confirmation before turning image analysis on, and not before turning it off', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'auto' }, hasStoredKey: true, isReady: true };
    await mount();
    const toggle = () => host.querySelector<HTMLInputElement>('input[aria-label="Analisar imagens com Clef"]')!;
    await act(async () => { toggle().click(); });
    expect(orchSet()).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false);
    const confirmation = host.querySelector('[aria-label="Confirmar envio de imagens"]')!;
    expect(confirmation.textContent).toContain('Cloudflare');
    await act(async () => { button('Cancelar').click(); });
    expect(host.querySelector('[aria-label="Confirmar envio de imagens"]')).toBeNull();
    expect(orchSet()).not.toHaveBeenCalled();
    await act(async () => { toggle().click(); });
    await act(async () => { button('Ativar análise de imagens').click(); });
    expect(status.settings.visionEnabled).toBe(true);
    await act(async () => { toggle().click(); });
    expect(status.settings.visionEnabled).toBe(false);
    expect(host.querySelector('[aria-label="Confirmar envio de imagens"]')).toBeNull();
  });

  it('says Somente Clef leaves the safeguards without a Jev judgment, and Juntos sends that security text to Clef', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'clef' }, isReady: true, hasStoredKey: true };
    await mount();
    const clef = host.textContent ?? '';
    expect(clef).toContain('sem rota');
    expect(clef).toContain('sem julgamento do Jev');
    expect(clef).not.toContain('continuam só no Jev');
    act(() => root.unmount()); host.remove();
    status = { ...status, settings: { ...status.settings, mode: 'together' }, lunaReady: true };
    await mount();
    const together = host.textContent ?? '';
    expect(together.indexOf('também vai para o Clef')).toBeLessThan(together.indexOf('Juntos é opt-in'));
    expect(together).toContain('dispatchGuard');
    expect(together).toContain('handoffReview');
    expect(together).toContain('memoryDistill');
    expect(together).toContain('computerTool');
    expect(together).toContain('browserTool');
    expect(together).toContain('Luna e Clef sem o Jev');
  });

  it('tells the operator what leaves the machine and that the pixel mask is only partial', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'auto' } };
    await mount();
    const text = host.textContent ?? '';
    expect(text).toMatch(/pane/i);
    expect(text).toMatch(/terminal/i);
    expect(text).toContain('só no Jev');
    await act(async () => { host.querySelector<HTMLInputElement>('input[aria-label="Analisar imagens com Clef"]')!.click(); });
    const confirmation = host.querySelector('[aria-label="Confirmar envio de imagens"]')!.textContent!;
    expect(confirmation).toContain('parcial');
    expect(confirmation).toContain('não garante');
    expect(confirmation).toContain('perfil pessoal');
  });

  it('warns when the chosen provider is not ready and when Automatic would fall back to Cloudflare', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'clef' } };
    await mount();
    expect(notices()).toContain('Somente Clef');
    expect(notices()).toContain('API Token');
    act(() => root.unmount()); host.remove();
    status = { ...status, settings: { ...status.settings, mode: 'auto' }, jevReady: false, hasStoredKey: true, isReady: true };
    await mount();
    expect(notices()).toContain('Sem chave Jev');
  });

  it.each(['luna', 'together'] as const)('requires new recipient confirmation when switching existing Clef vision to %s', async mode => {
    status = { ...status, settings: { ...status.settings, mode: 'clef', visionEnabled: true }, isReady: true, lunaReady: true };
    await mount();
    await act(async () => { choose('Escolha do modelo', mode); });
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    expect(status.settings).not.toHaveProperty('visionConsent');
    orchSet().mockClear();
    await act(async () => { checkbox.click(); });
    expect(orchSet()).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Confirmar envio de imagens"]')?.textContent).toContain('OpenAI');
    await act(async () => { button('Ativar análise de imagens').click(); });
    expect(status.settings).toMatchObject({ visionEnabled: true, visionConsent: { version: 1, recipients: ['clef', 'luna'] } });
  });

  it('keeps old Automatic Clef consent active and explicitly confirms adding OpenAI', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'auto', visionEnabled: true }, isReady: true, lunaReady: true };
    await mount();
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(orchSet()).not.toHaveBeenCalled();
    await act(async () => { button('Autorizar também a OpenAI').click(); });
    expect(orchSet()).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Confirmar envio de imagens"]')?.textContent).toContain('OpenAI');
    await act(async () => { button('Cancelar').click(); });
    expect(status.settings).not.toHaveProperty('visionConsent');
    await act(async () => { button('Autorizar também a OpenAI').click(); });
    await act(async () => { button('Ativar análise de imagens').click(); });
    expect(status.settings).toMatchObject({ visionConsent: { version: 1, recipients: ['clef', 'luna'] } });
    expect(host.textContent).not.toContain('Autorizar também a OpenAI');
  });

  it('dismisses a pending Cloudflare confirmation when the selected recipient changes', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'clef' }, isReady: true, lunaReady: true };
    await mount();
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(host.querySelector('[aria-label="Confirmar envio de imagens"]')).not.toBeNull();
    await act(async () => { choose('Escolha do modelo', 'luna'); });
    expect(host.querySelector('[aria-label="Confirmar envio de imagens"]')).toBeNull();
    expect(status.settings.visionEnabled).toBe(false);
  });

  it('tests Luna through the OpenAI key without a Cloudflare account', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'luna' }, lunaReady: true };
    await mount();
    expect(host.textContent).toContain('Somente Luna (beta)');
    await act(async () => { button('Testar a Luna').click(); });
    expect(bridge().test).toHaveBeenCalledWith({ provider: 'luna' });
  });

  it('Automático também testa a Luna (ela entra na rota e na calibração); modo fixo no Jev não', async () => {
    status = { ...status, settings: { ...status.settings, mode: 'auto' }, lunaReady: true };
    await mount();
    await act(async () => { button('Testar a Luna').click(); });
    expect(bridge().test).toHaveBeenCalledWith({ provider: 'luna' });
    await act(async () => { choose('Escolha do modelo', 'jev'); });
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Testar a Luna')).toBe(false);
  });

  it('shows failed connection tests inline', async () => {
    status = { ...status, hasStoredKey: true, keyMasked: 'syn…oken', isReady: true };
    await mount(); await act(async () => { button('Testar conexão').click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Token recusado');
  });

  it('shows an inline error when the status cannot be loaded', async () => {
    statusFails = true; await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Não consegui carregar');
    expect(host.querySelector('select')).toBeNull();
  });

  it('keeps older bridges usable without the Clef namespace', async () => {
    delete (window.nexus as any).decisionModels;
    await mount();
    expect(host.textContent).toContain('atualize');
  });
});
