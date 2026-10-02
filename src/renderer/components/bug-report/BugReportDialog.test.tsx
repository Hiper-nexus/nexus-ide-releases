/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BugReportDialog } from './BugReportDialog';
import { useBugReportDialogStore } from '../../state/bug-report-dialog-store';
import { useConfirmStore } from '../../state/confirm-store';
import { useLayoutStore } from '../../state/layout-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import type {
  BugReportPayload,
  BugReportPreviewResult,
  BugReportRequest,
  BugReportSubmitResult,
} from '../../../shared/bug-report';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const DIGEST = 'c'.repeat(64);

const payload: BugReportPayload = {
  title: 'O terminal trava ao colar',
  description: 'Ao colar um texto longo o pane congela por alguns segundos.',
  category: 'terminal',
  impact: 'annoying',
  app: { version: '0.76.161', platform: 'darwin', arch: 'arm64', osVersion: '27.2.0' },
  consent: { diagnostics: false },
};

type Submit = (request: BugReportRequest) => Promise<BugReportSubmitResult>;
type Preview = (request: BugReportRequest) => Promise<BugReportPreviewResult>;

let host: HTMLDivElement;
let root: Root;
let submit: ReturnType<typeof vi.fn<Submit>>;
let preview: ReturnType<typeof vi.fn<Preview>>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<BugReportDialog />));
}

function openDialog(): void {
  act(() => useBugReportDialogStore.getState().open());
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error('dialog not open');
  return el;
}

function field<T extends HTMLElement>(label: RegExp): T {
  const labels = Array.from(dialog().querySelectorAll('label'));
  const match = labels.find((candidate) => label.test(candidate.textContent ?? ''));
  if (!match) throw new Error(`label ${label} not found`);
  const target = match.htmlFor
    ? document.getElementById(match.htmlFor)
    : match.querySelector('input,textarea,select');
  if (!target) throw new Error(`control for ${label} not found`);
  return target as T;
}

function button(label: RegExp): HTMLButtonElement {
  const found = Array.from(dialog().querySelectorAll('button')).find((candidate) =>
    label.test(candidate.textContent ?? ''),
  );
  if (!found) throw new Error(`button ${label} not found`);
  return found;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

function fillValid(): void {
  setValue(field<HTMLInputElement>(/^Título/), 'O terminal trava ao colar');
  setValue(
    field<HTMLTextAreaElement>(/O que aconteceu/),
    'Ao colar um texto longo o pane congela por alguns segundos.',
  );
}

function keydown(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await flush();
}

beforeEach(() => {
  submit = vi.fn<Submit>(async () => ({ ok: true, id: 'BR-0001' }));
  preview = vi.fn<Preview>(async () => ({ ok: true, payload, digest: DIGEST }));
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { bugReport: { submit, preview, onOpenRequest: () => () => {} } },
  });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  useBugReportDialogStore.setState({ isOpen: false });
  useConfirmStore.setState({ pending: null, queue: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'nexus');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('BugReportDialog — opening, focus and keyboard', () => {
  it('renders nothing while closed', () => {
    mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens as a labelled modal dialog with focus on the title field', () => {
    mount();
    openDialog();
    const el = dialog();
    expect(el.getAttribute('aria-modal')).toBe('true');
    const labelledBy = el.getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Reportar um problema');
    expect(document.activeElement).toBe(field(/^Título/));
  });

  it('starts with diagnostics OFF, the milder impact selected and the full category list', () => {
    mount();
    openDialog();
    expect(field<HTMLInputElement>(/Incluir diagnóstico técnico/).checked).toBe(false);
    const radios = Array.from(dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    const select = field<HTMLSelectElement>(/Categoria/);
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'crash', 'terminal', 'agents', 'license', 'billing', 'ui', 'performance', 'other',
    ]);
    expect(dialog().textContent).toContain('Atrapalha');
    expect(dialog().textContent).toContain('Me impede de trabalhar');
  });

  it('says plainly what the diagnostics checkbox covers', () => {
    mount();
    openDialog();
    expect(dialog().textContent).toContain('Incluir diagnóstico técnico (sem prompts, sem código e sem chaves)');
  });

  it('Escape closes the dialog and returns focus to where it was', () => {
    const opener = document.createElement('button');
    opener.textContent = 'abrir';
    document.body.appendChild(opener);
    opener.focus();
    mount();
    openDialog();
    expect(document.activeElement).not.toBe(opener);
    const event = keydown(dialog(), 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside the dialog (wraps from last to first and back)', () => {
    mount();
    openDialog();
    const focusables = Array.from(
      dialog().querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select'),
    );
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    last.focus();
    const forward = keydown(last, 'Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const backward = keydown(first, 'Tab', { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('starts fresh every time it opens', () => {
    mount();
    openDialog();
    setValue(field<HTMLInputElement>(/^Título/), 'Algo que eu digitei');
    act(() => useBugReportDialogStore.getState().close());
    openDialog();
    expect(field<HTMLInputElement>(/^Título/).value).toBe('');
  });
});

describe('BugReportDialog — validation', () => {
  it('blocks sending and explains each invalid field', async () => {
    mount();
    openDialog();
    await click(button(/Enviar relato/));
    expect(submit).not.toHaveBeenCalled();
    const title = field<HTMLInputElement>(/^Título/);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(dialog().textContent).toMatch(/pelo menos 5 caracteres/);
    expect(dialog().textContent).toMatch(/pelo menos 10 caracteres/);
    const describedBy = title.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ').some((id) => document.getElementById(id)?.textContent?.includes('pelo menos 5'))).toBe(true);
    expect(document.activeElement).toBe(title);
  });

  it('flags text that is too long', async () => {
    mount();
    openDialog();
    setValue(field<HTMLInputElement>(/^Título/), 'Título válido');
    setValue(field<HTMLTextAreaElement>(/O que aconteceu/), 'x'.repeat(4001));
    await click(button(/Enviar relato/));
    expect(submit).not.toHaveBeenCalled();
    expect(dialog().textContent).toMatch(/no máximo 4000/);
  });

  it('does not ask for a preview of an invalid report', async () => {
    mount();
    openDialog();
    await click(button(/Ver exatamente o que será enviado/));
    expect(preview).not.toHaveBeenCalled();
    expect(dialog().textContent).toMatch(/pelo menos 5 caracteres/);
  });
});

describe('BugReportDialog — consent and the request sent to Main', () => {
  it('sends includeDiagnostics=false by default (no diagnostics requested)', async () => {
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    expect(submit).toHaveBeenCalledTimes(1);
    const request = submit.mock.calls[0]![0];
    expect(request.includeDiagnostics).toBe(false);
    expect(request).not.toHaveProperty('activePaneId');
    expect(request).toMatchObject({
      title: 'O terminal trava ao colar',
      category: 'other',
      impact: 'annoying',
    });
  });

  it('sends includeDiagnostics=true only after the person ticks the box', async () => {
    mount();
    openDialog();
    fillValid();
    await click(field<HTMLInputElement>(/Incluir diagnóstico técnico/));
    expect(field<HTMLInputElement>(/Incluir diagnóstico técnico/).checked).toBe(true);
    await click(button(/Enviar relato/));
    expect(submit.mock.calls[0]![0].includeDiagnostics).toBe(true);
  });

  it('sends the chosen category, impact and optional steps', async () => {
    mount();
    openDialog();
    fillValid();
    setValue(field<HTMLSelectElement>(/Categoria/), 'billing');
    await click(dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!);
    setValue(field<HTMLTextAreaElement>(/Passos para reproduzir/), '1. Colar\n2. Esperar');
    await click(button(/Enviar relato/));
    expect(submit.mock.calls[0]![0]).toMatchObject({
      category: 'billing',
      impact: 'blocks_work',
      steps: '1. Colar\n2. Esperar',
    });
  });
});

describe('BugReportDialog — preview ("o que será enviado")', () => {
  it('shows exactly the JSON the main process returned, as text', async () => {
    mount();
    openDialog();
    fillValid();
    await click(button(/Ver exatamente o que será enviado/));
    expect(preview).toHaveBeenCalledTimes(1);
    const shown = dialog().querySelector('pre');
    expect(shown?.textContent).toBe(JSON.stringify(payload, null, 2));
    expect(button(/Ver exatamente|Ocultar/).getAttribute('aria-expanded')).toBe('true');
  });

  it('scrolls the opened preview into view without stealing focus', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      mount();
      openDialog();
      fillValid();
      const toggle = button(/Ver exatamente o que será enviado/);
      toggle.focus();
      await click(toggle);
      expect(scrollIntoView).toHaveBeenCalled();
      expect(document.activeElement).toBe(button(/Ocultar o que será enviado/));
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('previews the same request that submit later sends, tied to the body the person saw', async () => {
    mount();
    openDialog();
    fillValid();
    await click(field<HTMLInputElement>(/Incluir diagnóstico técnico/));
    await click(button(/Ver exatamente o que será enviado/));
    await click(button(/Enviar relato/));
    expect(submit.mock.calls[0]![0]).toEqual({ ...preview.mock.calls[0]![0], previewDigest: DIGEST });
    // A prévia não leva o resumo: ele só existe depois que o Main responde.
    expect(preview.mock.calls[0]![0]).not.toHaveProperty('previewDigest');
  });

  it('sends no digest when the person never opened the preview, or closed it', async () => {
    submit.mockResolvedValueOnce({ ok: false, code: 'network', message: 'Sem conexão.', payload });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    expect(submit.mock.calls[0]![0]).not.toHaveProperty('previewDigest');
    await click(button(/Ver exatamente o que será enviado/));
    await click(button(/Ocultar o que será enviado/));
    await click(button(/Enviar relato/));
    expect(submit.mock.calls[1]![0]).not.toHaveProperty('previewDigest');
  });

  it('uses the pane that was focused when the dialog opened, for both preview and submit', async () => {
    useLayoutStore.setState({ focusedPaneId: 'pane-A' } as never);
    mount();
    openDialog();
    fillValid();
    await click(field<HTMLInputElement>(/Incluir diagnóstico técnico/));
    useLayoutStore.setState({ focusedPaneId: 'pane-B' } as never);
    await click(button(/Ver exatamente o que será enviado/));
    await click(button(/Enviar relato/));
    expect(preview.mock.calls[0]![0].activePaneId).toBe('pane-A');
    expect(submit.mock.calls[0]![0].activePaneId).toBe('pane-A');
    useLayoutStore.setState({ focusedPaneId: null } as never);
  });

  it('when Main says the preview is stale, hides it, explains and keeps the text', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      code: 'stale-preview',
      message: 'O conteúdo mudou desde a prévia que você conferiu.',
    });
    mount();
    openDialog();
    fillValid();
    await click(button(/Ver exatamente o que será enviado/));
    await click(button(/Enviar relato/));
    expect(dialog().querySelector('pre')).toBeNull();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('mudou desde a prévia');
    expect(field<HTMLInputElement>(/^Título/).value).toBe('O terminal trava ao colar');
    await click(button(/Ver exatamente o que será enviado/));
    expect(dialog().querySelector('pre')).not.toBeNull();
  });

  it('hides a stale preview as soon as anything changes', async () => {
    mount();
    openDialog();
    fillValid();
    await click(button(/Ver exatamente o que será enviado/));
    expect(dialog().querySelector('pre')).not.toBeNull();
    setValue(field<HTMLInputElement>(/^Título/), 'Outro título para o relato');
    expect(dialog().querySelector('pre')).toBeNull();
    await click(button(/Ver exatamente o que será enviado/));
    await click(field<HTMLInputElement>(/Incluir diagnóstico técnico/));
    expect(dialog().querySelector('pre')).toBeNull();
  });

  it('renders markup from the payload as plain text', async () => {
    preview.mockResolvedValue({
      ok: true,
      payload: { ...payload, description: '<img src=x onerror="alert(1)"> descrição longa o bastante' },
      digest: DIGEST,
    });
    mount();
    openDialog();
    fillValid();
    await click(button(/Ver exatamente o que será enviado/));
    expect(dialog().querySelector('img')).toBeNull();
    expect(dialog().querySelector('pre')?.textContent).toContain('<img src=x onerror=');
  });

  it('shows the reason when the preview fails', async () => {
    preview.mockResolvedValue({ ok: false, code: 'invalid', message: 'Confira o relato.' });
    mount();
    openDialog();
    fillValid();
    await click(button(/Ver exatamente o que será enviado/));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Confira o relato.');
    expect(dialog().querySelector('pre')).toBeNull();
  });
});

describe('BugReportDialog — sending states', () => {
  it('shows a sending state, ignores Escape meanwhile, then the success message with the code', async () => {
    let finish: (result: BugReportSubmitResult) => void = () => undefined;
    submit.mockImplementation(
      () => new Promise<BugReportSubmitResult>((resolve) => { finish = resolve; }),
    );
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    expect(dialog().getAttribute('aria-busy')).toBe('true');
    expect(button(/Enviando/).disabled).toBe(true);
    const escape = keydown(dialog(), 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      finish({ ok: true, id: 'BR-0042' });
      await Promise.resolve();
    });
    await flush();
    const status = dialog().querySelector('[role="status"]');
    expect(status?.textContent).toBe('Relato enviado, obrigado. Código: BR-0042');
    expect(document.activeElement).toBe(button(/Fechar/));
    await click(button(/Fechar/));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the server reason, keeps what was typed and allows trying again', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      code: 'rate-limited',
      message: 'Limite de 5 relatos por hora atingido.',
      payload,
    });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    const alert = dialog().querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Limite de 5 relatos por hora atingido.');
    expect(field<HTMLInputElement>(/^Título/).value).toBe('O terminal trava ao colar');
    expect(button(/Enviar relato/).disabled).toBe(false);
    await click(button(/Enviar relato/));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(dialog().querySelector('[role="status"]')?.textContent).toContain('BR-0001');
  });

  it('treats a rejected IPC call as a failure instead of crashing', async () => {
    submit.mockRejectedValueOnce(new Error('ipc sender não autorizado'));
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    const alert = dialog().querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Não consegui enviar/);
    expect(alert?.textContent).not.toContain('ipc sender');
  });

  it('asks the person to sign in when there is no session and offers the account screen', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      code: 'no-session',
      message: 'Você precisa entrar na sua conta Nexus para enviar o relato.',
      payload,
    });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('entrar na sua conta');
    await click(button(/Abrir Minha conta/));
    // O texto digitado seria descartado: pergunta antes de sair.
    expect(useConfirmStore.getState().pending?.title).toMatch(/Sair do relato/);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      useConfirmStore.getState().decide(true);
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useProductNavigationStore.getState().destination).toMatchObject({
      kind: 'settings',
      section: 'account',
    });
  });

  it('stays on the report when the person declines to leave for the account screen', async () => {
    submit.mockResolvedValueOnce({ ok: false, code: 'no-session', message: 'Entre na conta.', payload });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    await click(button(/Abrir Minha conta/));
    await act(async () => {
      useConfirmStore.getState().decide(false);
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(field<HTMLInputElement>(/^Título/).value).toBe('O terminal trava ao colar');
  });

  it('only offers the account shortcut for the no-session failure', async () => {
    submit.mockResolvedValueOnce({ ok: false, code: 'network', message: 'Sem conexão.', payload });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    expect(Array.from(dialog().querySelectorAll('button')).some((b) => /Minha conta/.test(b.textContent ?? ''))).toBe(false);
  });
});

describe('BugReportDialog — closing without losing what was typed', () => {
  async function decide(ok: boolean): Promise<void> {
    await act(async () => {
      useConfirmStore.getState().decide(ok);
      await Promise.resolve();
    });
  }

  it('asks before Escape discards typed text, and keeps the report when declined', async () => {
    mount();
    openDialog();
    setValue(field<HTMLInputElement>(/^Título/), 'Algo que eu digitei');
    keydown(dialog(), 'Escape');
    expect(useConfirmStore.getState().pending?.title).toMatch(/Descartar o relato/);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await decide(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(field<HTMLInputElement>(/^Título/).value).toBe('Algo que eu digitei');
    expect(document.activeElement).toBe(field(/^Título/));
  });

  it('closes after the person confirms the discard', async () => {
    mount();
    openDialog();
    setValue(field<HTMLInputElement>(/^Título/), 'Algo que eu digitei');
    keydown(dialog(), 'Escape');
    await decide(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Cancelar follows the same rule', async () => {
    mount();
    openDialog();
    setValue(field<HTMLInputElement>(/^Título/), 'Algo que eu digitei');
    await click(button(/Cancelar/));
    expect(useConfirmStore.getState().pending).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('closes at once when nothing was typed', async () => {
    mount();
    openDialog();
    await click(button(/Cancelar/));
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('ignores Escape while an input method is composing', () => {
    mount();
    openDialog();
    const event = keydown(dialog(), 'Escape', { isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe('BugReportDialog — announcements and implicit submission', () => {
  it('has a persistent polite live region from the first render, empty until something happens', () => {
    mount();
    openDialog();
    const region = dialog().querySelector('[role="status"][aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe('');
  });

  it('announces sending, then the sent code, in that same region', async () => {
    let finish: (result: BugReportSubmitResult) => void = () => undefined;
    submit.mockImplementation(() => new Promise<BugReportSubmitResult>((resolve) => { finish = resolve; }));
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    const region = dialog().querySelector('[role="status"][aria-live="polite"]');
    expect(region?.textContent).toMatch(/Enviando/);
    await act(async () => {
      finish({ ok: true, id: 'BR-0042' });
      await Promise.resolve();
    });
    await flush();
    expect(dialog().querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      'Relato enviado, obrigado. Código: BR-0042',
    );
  });

  it('does not send on implicit form submission (Enter in the title field)', async () => {
    mount();
    openDialog();
    fillValid();
    const form = dialog().querySelector('form')!;
    const event = new Event('submit', { bubbles: true, cancelable: true });
    act(() => {
      form.dispatchEvent(event);
    });
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(button(/Enviar relato/).type).toBe('button');
  });

  it('labels the scrollable preview as a region', async () => {
    mount();
    openDialog();
    fillValid();
    await click(button(/Ver exatamente o que será enviado/));
    expect(dialog().querySelector('pre')?.getAttribute('role')).toBe('region');
  });
});

describe('BugReportDialog — "Copiar relato"', () => {
  it('copies the markdown of the (redacted) payload returned with the failure', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      code: 'network',
      message: 'Não consegui falar com o servidor.',
      payload: { ...payload, description: 'Descrição já redigida pelo Main, sem dados pessoais.' },
    });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    await click(button(/Copiar relato/));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain('# O terminal trava ao colar');
    expect(copied).toContain('Descrição já redigida pelo Main');
    expect(copied).toContain('NexusIDE 0.76.161');
    expect(dialog().querySelector('[role="status"]')?.textContent).toMatch(/copiado/i);
  });

  it('does not copy a stale body after the text changed: it asks Main for a fresh redacted one', async () => {
    submit.mockResolvedValueOnce({
      ok: false,
      code: 'network',
      message: 'Sem conexão.',
      payload: {
        ...payload,
        title: 'Título antigo da falha',
        consent: { diagnostics: true },
        context: { adapter: 'claude', paneCount: 1, missionActive: false },
        diagnostics: { events: [{ t: 1, kind: 'agent-pty-exit' }], errors: [] },
      },
    });
    preview.mockResolvedValueOnce({
      ok: true,
      payload: { ...payload, title: 'Título novo redigido' },
      digest: DIGEST,
    });
    mount();
    openDialog();
    fillValid();
    await click(field<HTMLInputElement>(/Incluir diagnóstico técnico/));
    await click(button(/Enviar relato/));
    // Depois da falha a pessoa desliga o diagnóstico e muda o título.
    await click(field<HTMLInputElement>(/Incluir diagnóstico técnico/));
    setValue(field<HTMLInputElement>(/^Título/), 'Título novo digitado');
    await click(button(/Copiar relato/));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]![0].includeDiagnostics).toBe(false);
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain('Título novo redigido');
    expect(copied).not.toContain('Título antigo');
    expect(copied).not.toContain('Diagnóstico técnico');
  });

  it('falls back to the typed text when the fresh body cannot be built', async () => {
    submit.mockResolvedValueOnce({ ok: false, code: 'network', message: 'Sem conexão.', payload });
    preview.mockRejectedValueOnce(new Error('boom'));
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    setValue(field<HTMLInputElement>(/^Título/), 'Título novo digitado');
    await click(button(/Copiar relato/));
    expect(writeText.mock.calls[0]![0]).toContain('# Título novo digitado');
    // Sem corpo redigido do Main, a cópia é do texto digitado: a tela diz que não houve limpeza.
    expect(dialog().textContent).toMatch(/sem a limpeza automática/i);
  });

  it('falls back to the typed text when Main returned no body', async () => {
    submit.mockResolvedValueOnce({ ok: false, code: 'busy', message: 'Já estou enviando.' });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    await click(button(/Copiar relato/));
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain('# O terminal trava ao colar');
    expect(copied).toContain('Ao colar um texto longo');
  });

  it('tells the person when the clipboard is unavailable', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    submit.mockResolvedValueOnce({ ok: false, code: 'network', message: 'Sem conexão.', payload });
    mount();
    openDialog();
    fillValid();
    await click(button(/Enviar relato/));
    await click(button(/Copiar relato/));
    expect(dialog().textContent).toMatch(/Não foi possível copiar/);
  });
});
