import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  closeOmpAuthWindow,
  disposeOmpAuthWindow,
  isAllowedOmpAuthUrl,
  openOmpAuthWindow,
  OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS,
} from './omp-auth-window';

/**
 * A janela real é Electron; nos testes injetamos uma factory fake (mesmo
 * padrão dos testes de IPC do main, que mockam `electron`).
 */
function fakeWindow() {
  const win = {
    destroyed: false,
    loaded: [] as string[],
    focused: 0,
    closed: 0,
    handlers: new Map<string, () => void>(),
    loadURL(url: string) {
      this.loaded.push(url);
      return Promise.resolve();
    },
    focus() {
      this.focused += 1;
    },
    close() {
      this.closed += 1;
      this.destroyed = true;
      this.handlers.get('closed')?.();
    },
    isDestroyed() {
      return this.destroyed;
    },
    on(event: string, cb: () => void) {
      this.handlers.set(event, cb);
    },
  };
  return win;
}

function asBrowserWindow(win: ReturnType<typeof fakeWindow>): BrowserWindow {
  return win as unknown as BrowserWindow;
}

describe('isAllowedOmpAuthUrl', () => {
  it('aceita https qualquer host', () => {
    expect(isAllowedOmpAuthUrl('https://auth.oh-my-pi.dev/login?x=1')).toBe(true);
  });

  it('aceita http só em loopback (callback local de device-flow)', () => {
    expect(isAllowedOmpAuthUrl('http://localhost:8787/callback')).toBe(true);
    expect(isAllowedOmpAuthUrl('http://127.0.0.1:8787/callback')).toBe(true);
    expect(isAllowedOmpAuthUrl('http://[::1]:8787/callback')).toBe(true);
    expect(isAllowedOmpAuthUrl('http://169.254.0.1/callback')).toBe(false);
    expect(isAllowedOmpAuthUrl('http://evil.example/callback')).toBe(false);
  });

  it('recusa javascript:, file:, data: e lixo', () => {
    expect(isAllowedOmpAuthUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedOmpAuthUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedOmpAuthUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isAllowedOmpAuthUrl('not a url')).toBe(false);
  });
});

describe('openOmpAuthWindow / closeOmpAuthWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    disposeOmpAuthWindow();
    vi.useRealTimers();
  });

  it('recusa URL inválida sem criar janela', () => {
    const factory = vi.fn();
    const res = openOmpAuthWindow('file:///etc/passwd', factory);
    expect(res.ok).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it('cria a janela via factory e foca', () => {
    const win = fakeWindow();
    const factory = vi.fn(() => asBrowserWindow(win));
    const res = openOmpAuthWindow('https://auth.example/login', factory);
    expect(res).toEqual({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(win.focused).toBe(1);
  });

  it('reutiliza a janela viva: recarrega URL e foca sem recriar', () => {
    const win = fakeWindow();
    const factory = vi.fn(() => asBrowserWindow(win));
    openOmpAuthWindow('https://auth.example/a', factory);
    const res = openOmpAuthWindow('https://auth.example/b', factory);
    expect(res.ok).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(win.loaded).toEqual(['https://auth.example/b']);
    expect(win.focused).toBe(2);
  });

  it('fecha imediatamente sem delay e tolera fechar sem janela', () => {
    expect(() => closeOmpAuthWindow()).not.toThrow();
    const win = fakeWindow();
    openOmpAuthWindow('https://auth.example/a', () => asBrowserWindow(win));
    closeOmpAuthWindow();
    expect(win.closed).toBe(1);
    // Segundo close é no-op seguro.
    expect(() => closeOmpAuthWindow()).not.toThrow();
  });

  it('com delay agenda o fechamento (página de sucesso perceptível)', () => {
    const win = fakeWindow();
    openOmpAuthWindow('https://auth.example/a', () => asBrowserWindow(win));
    closeOmpAuthWindow(OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS);
    expect(win.closed).toBe(0);
    vi.advanceTimersByTime(OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS + 1);
    expect(win.closed).toBe(1);
  });

  it('um novo open cancela o fechamento agendado', () => {
    const win = fakeWindow();
    openOmpAuthWindow('https://auth.example/a', () => asBrowserWindow(win));
    closeOmpAuthWindow(OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS);
    openOmpAuthWindow('https://auth.example/b', () => asBrowserWindow(win));
    vi.advanceTimersByTime(OMP_AUTH_WINDOW_CLOSE_ON_DONE_DELAY_MS + 1_000);
    expect(win.closed).toBe(0);
  });
});
