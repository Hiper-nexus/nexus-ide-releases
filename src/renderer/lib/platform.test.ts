/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { formatShortcut, isMac, modKey, uiPlatform, xtermWindowsPty } from './platform';

function setPlatform(p: NodeJS.Platform | undefined) {
  (window as { nexus?: { platform?: NodeJS.Platform } }).nexus = p
    ? { platform: p }
    : undefined;
}

afterEach(() => setPlatform(undefined));

describe('platform helpers', () => {
  it('mapeia darwin/win32/linux para uiPlatform', () => {
    setPlatform('darwin');
    expect(uiPlatform()).toBe('mac');
    setPlatform('win32');
    expect(uiPlatform()).toBe('windows');
    setPlatform('linux');
    expect(uiPlatform()).toBe('linux');
  });

  it('sem bridge (testes/web) cai em linux, nunca quebra', () => {
    setPlatform(undefined);
    expect(uiPlatform()).toBe('linux');
    expect(isMac()).toBe(false);
  });

  it('modKey: ⌘ no mac, Ctrl no resto', () => {
    setPlatform('darwin');
    expect(modKey()).toBe('⌘');
    setPlatform('win32');
    expect(modKey()).toBe('Ctrl');
  });

  it('formatShortcut: mac junta glifos sem separador e em ordem canônica', () => {
    setPlatform('darwin');
    expect(formatShortcut('mod', 'K')).toBe('⌘K');
    expect(formatShortcut('mod', 'shift', 'P')).toBe('⇧⌘P');
    expect(formatShortcut('mod', 'alt', 'enter')).toBe('⌥⌘↵');
    expect(formatShortcut('ctrl', 'alt', 'shift', 'mod', 'D')).toBe('⌃⌥⇧⌘D');
  });

  it('formatShortcut: windows/linux junta com + e nomeia teclas', () => {
    setPlatform('win32');
    expect(formatShortcut('mod', 'K')).toBe('Ctrl+K');
    expect(formatShortcut('mod', 'shift', 'P')).toBe('Ctrl+Shift+P');
    expect(formatShortcut('mod', 'alt', 'enter')).toBe('Ctrl+Alt+Enter');
    expect(formatShortcut('esc')).toBe('Esc');
  });
});

describe('xterm no ConPTY (F-673)', () => {
  it('no Windows informa backend conpty e o build para o xterm', () => {
    (window as { nexus?: unknown }).nexus = { platform: 'win32', windowsBuild: 26200 };
    expect(xtermWindowsPty()).toEqual({ backend: 'conpty', buildNumber: 26200 });
    (window as { nexus?: unknown }).nexus = { platform: 'win32', windowsBuild: null };
    expect(xtermWindowsPty()).toEqual({ backend: 'conpty' });
  });
  it('fora do Windows não mexe no xterm', () => {
    setPlatform('darwin');
    expect(xtermWindowsPty()).toBeUndefined();
    setPlatform(undefined);
    expect(xtermWindowsPty()).toBeUndefined();
  });
});
