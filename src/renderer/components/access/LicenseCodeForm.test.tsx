/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LicenseCodeForm, type LicenseCodeFormProps } from './LicenseCodeForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function props(over: Partial<LicenseCodeFormProps> = {}): LicenseCodeFormProps {
  return { enabled: true, busy: false, succeeded: false, error: null, onSubmit: vi.fn(), ...over };
}

async function render(p: LicenseCodeFormProps) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<LicenseCodeForm {...p} />));
  return host;
}

const rerender = (p: LicenseCodeFormProps) => act(async () => root!.render(<LicenseCodeForm {...p} />));
const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
const input = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input')!;
const submitButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;

async function open(el: HTMLElement) {
  await act(async () => toggle(el).click());
}

async function type(el: HTMLElement, value: string) {
  const field = input(el);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('LicenseCodeForm', () => {
  it('começa recolhido: só o botão "Tenho um código", anunciado como recolhido', async () => {
    const el = await render(props());
    expect(toggle(el).textContent).toBe('Tenho um código');
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('input')).toBeNull();
  });

  it('ao abrir, o foco vai para o campo (o botão some e o foco não pode cair no body)', async () => {
    const el = await render(props());
    await open(el);
    expect(document.activeElement).toBe(input(el));
  });

  it('envia o código sem espaços pelo botão e pelo submit do formulário (Enter)', async () => {
    const onSubmit = vi.fn();
    const el = await render(props({ onSubmit }));
    await open(el);
    await type(el, '  NEXUS-AAAA-BBBB-CCCC  ');
    await act(async () => submitButton(el).click());
    expect(onSubmit).toHaveBeenCalledWith('NEXUS-AAAA-BBBB-CCCC');
    await act(async () => { el.querySelector('form')!.requestSubmit(); });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('só espaços não envia e deixa o botão desabilitado', async () => {
    const onSubmit = vi.fn();
    const el = await render(props({ onSubmit }));
    await open(el);
    await type(el, '    ');
    expect(submitButton(el).disabled).toBe(true);
    await act(async () => { el.querySelector('form')!.requestSubmit(); });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sem conta logada: explica o motivo e nunca envia, nem pelo teclado', async () => {
    const onSubmit = vi.fn();
    const el = await render(props({ enabled: false, onSubmit }));
    await open(el);
    await type(el, 'NEXUS-AAAA-BBBB-CCCC');
    expect(el.textContent).toContain('Entre na sua conta para resgatar um código.');
    expect(submitButton(el).disabled).toBe(true);
    await act(async () => { el.querySelector('form')!.requestSubmit(); });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('enquanto ativa: campo só-leitura (mantém o foco), aria-busy, rótulo "Ativando…" e sem segundo envio', async () => {
    const onSubmit = vi.fn();
    const el = await render(props({ onSubmit }));
    await open(el);
    await type(el, 'NEXUS-AAAA-BBBB-CCCC');
    await rerender(props({ busy: true, onSubmit }));
    expect(input(el).readOnly).toBe(true);
    expect(input(el).disabled).toBe(false);
    expect(input(el).getAttribute('aria-busy')).toBe('true');
    expect(submitButton(el).textContent).toBe('Ativando…');
    expect(submitButton(el).disabled).toBe(true);
    await act(async () => { el.querySelector('form')!.requestSubmit(); });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('erro: aparece em alerta, o campo aponta para ele e o foco volta ao campo para corrigir', async () => {
    const el = await render(props());
    await open(el);
    await type(el, 'NEXUS-AAAA-BBBB-CCCC');
    await rerender(props({ busy: true }));
    (document.activeElement as HTMLElement | null)?.blur();
    await rerender(props({ busy: false, error: 'Código inválido, expirado ou já utilizado.' }));
    const alert = el.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('Código inválido, expirado ou já utilizado.');
    expect(input(el).getAttribute('aria-invalid')).toBe('true');
    expect(input(el).getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).not.toBe('');
    expect(document.activeElement).toBe(input(el));
  });

  it('sucesso: aviso em status, campo travado e botão desabilitado', async () => {
    const el = await render(props());
    await open(el);
    await type(el, 'NEXUS-AAAA-BBBB-CCCC');
    await rerender(props({ succeeded: true }));
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Licença ativada');
    expect(input(el).readOnly).toBe(true);
    expect(submitButton(el).disabled).toBe(true);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('o campo tem rótulo associado e não autocompleta nem corrige', async () => {
    const el = await render(props());
    await open(el);
    const label = el.querySelector('label')!;
    expect(label.htmlFor).toBe(input(el).id);
    expect(input(el).getAttribute('autocomplete')).toBe('off');
    expect(input(el).getAttribute('spellcheck')).toBe('false');
  });
});
