/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaProviderInfo } from '../../../shared/media-types';
import { MediaKeyField } from './MediaKeyField';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const setKey = vi.fn();

const provider = (hasKey: boolean): MediaProviderInfo => ({
  id: 'replicate-video',
  kind: 'video',
  label: 'Replicate — vídeo',
  envVar: 'REPLICATE_API_TOKEN',
  defaultModel: 'bytedance/seedance-2.0',
  models: ['bytedance/seedance-2.0'],
  hasKey,
  maskedKey: null,
} as MediaProviderInfo);

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`botão "${text}" ausente: ${host.textContent}`);
  return found;
}

function type(value: string): void {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  setKey.mockReset();
  Object.defineProperty(window, 'nexus', { configurable: true, value: { media: { setKey } } });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  Reflect.deleteProperty(window, 'nexus');
});

describe('MediaKeyField (F-1615)', () => {
  it('sem chave: Conectar só com texto, salva no cofre e limpa o campo', async () => {
    const onSaved = vi.fn();
    setKey.mockResolvedValue({ ok: true });
    await act(async () => root.render(<MediaKeyField provider={provider(false)} onSaved={onSaved} />));
    expect(button('Conectar').disabled).toBe(true);
    expect(host.textContent).not.toContain('Remover chave');
    type('r8_segredo');
    await act(async () => button('Conectar').click());
    expect(setKey).toHaveBeenCalledWith('replicate-video', 'r8_segredo');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(host.textContent).toContain('Chave salva');
  });

  it('recusa do Main vira frase e não chama onSaved', async () => {
    const onSaved = vi.fn();
    setKey.mockResolvedValue({ ok: false });
    await act(async () => root.render(<MediaKeyField provider={provider(false)} onSaved={onSaved} />));
    type('x');
    await act(async () => button('Conectar').click());
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Não foi possível salvar a chave');
  });

  it('com chave: troca e remove', async () => {
    const onSaved = vi.fn();
    setKey.mockResolvedValue({ ok: true });
    await act(async () => root.render(<MediaKeyField provider={provider(true)} onSaved={onSaved} />));
    expect(host.querySelector<HTMLInputElement>('input')!.placeholder).toBe('Cole uma nova chave para substituir');
    await act(async () => button('Remover chave').click());
    expect(setKey).toHaveBeenCalledWith('replicate-video', '');
    expect(host.textContent).toContain('Chave removida');
  });
});
