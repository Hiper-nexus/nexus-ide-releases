import { afterAll, beforeAll, describe, expect, it, vi, beforeEach, afterEach } from 'vitest';


vi.mock('electron', () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
  desktopCapturer: {
    getSources: vi.fn(),
  },
  screen: {
    getDisplayNearestPoint: vi.fn(() => ({ scaleFactor: 2 })),
  },
}));

import { desktopCapturer, screen, systemPreferences } from 'electron';
import {
  DesktopControlUnsupported,
  DesktopElementGone,
  DesktopSensitiveField,
  desktopControl,
  setElectronForTesting,
  setExecFileForTesting,
} from './desktop-control';

// O adapter é macOS-only e o CI roda em Linux: a suíte fixa darwin (o execFile
// é mockado, nada toca o SO) e o teste não-darwin troca para linux por conta
// própria e restaura.
const ORIGINAL_PLATFORM = process.platform;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
});

type ExecCallback = (
  err: Error | null,
  stdout: string,
  stderr: string,
) => void;

const execFileMock = vi.fn(
  (_bin: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
    cb(null, '{}', '');
  },
);

function jxaResponse(payload: unknown) {
  execFileMock.mockImplementation(
    (_b: string, _a: string[], _o: unknown, cb: ExecCallback) =>
      cb(null, JSON.stringify(payload), ''),
  );
}

function lastCall(): { bin: string; args: string[] } {
  const call = execFileMock.mock.calls.at(-1)!;
  return { bin: call[0] as string, args: call[1] as string[] };
}

function scriptOf(callArgs: string[]): string {
  const eIdx = callArgs.indexOf('-e');
  return callArgs[eIdx + 1]!;
}

function argvOf(callArgs: string[]): string[] {
  const dashIdx = callArgs.indexOf('--');
  return callArgs.slice(dashIdx + 1);
}

const ELEMENT = {
  role: 'AXButton',
  subrole: null,
  name: 'Save',
  value: null,
  enabled: true,
  frame: { x: 100, y: 200, w: 80, h: 30 },
  actions: ['AXPress'],
};

describe('desktop-control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setExecFileForTesting(execFileMock as never);
    vi.mocked(systemPreferences.isTrustedAccessibilityClient).mockReturnValue(true);
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('granted');
    setElectronForTesting({
      systemPreferences,
      desktopCapturer,
      screen,
    } as unknown as typeof import('electron'));
  });

  afterEach(() => {
    setExecFileForTesting(null);
    setElectronForTesting(null);
  });

  it('invokes /usr/bin/osascript with JXA and argv after --, never a shell', async () => {
    jxaResponse({ app: 'Finder' });
    const front = await desktopControl.frontmostApp();
    expect(front).toBe('Finder');
    const { bin, args } = lastCall();
    expect(bin).toBe('/usr/bin/osascript');
    expect(args[0]).toBe('-l');
    expect(args[1]).toBe('JavaScript');
    expect(args[2]).toBe('-e');
    expect(args).toContain('--');
    expect(scriptOf(args)).toContain('function run');
  });

  it('passes user strings as argv, never interpolated into the script', async () => {
    jxaResponse({ ok: true });
    const hostile = 'Finder"; do shell script "rm -rf ~';
    await desktopControl.activate(hostile);
    const { args } = lastCall();
    expect(scriptOf(args)).not.toContain(hostile);
    expect(argvOf(args)).toEqual([hostile]);
  });

  it('listElements maps kinds, flags sensitive fields and never reads secure values', async () => {
    jxaResponse({
      title: 'Dialog',
      elements: [
        ELEMENT,
        {
          ...ELEMENT,
          role: 'AXTextField',
          name: 'User',
          value: 'me',
          actions: [],
        },
        {
          ...ELEMENT,
          role: 'AXSecureTextField',
          name: 'Password',
          value: null,
          actions: [],
        },
        {
          ...ELEMENT,
          role: 'AXStaticText',
          name: 'label',
          actions: [],
          enabled: false,
        },
        {
          ...ELEMENT,
          role: 'AXButton',
          name: 'offscreen',
          frame: { x: 0, y: 0, w: 0, h: 0 },
        },
      ],
    });
    const { windowTitle, elements } = await desktopControl.listElements('App');
    expect(windowTitle).toBe('Dialog');
    const { args } = lastCall();
    // O script recusa ler value() de AXSecureTextField.
    expect(scriptOf(args)).toContain("role !== 'AXSecureTextField'");
    expect(elements).toHaveLength(4);
    const [button, field, secure, label] = elements;
    expect(button!.kind).toBe('clickable');
    expect(field!.kind).toBe('textfield');
    expect(secure!.sensitive).toBe(true);
    expect(secure!.value).toBeUndefined();
    expect(label!.kind).toBe('other');
    // Elemento fora da tela (w=0) é filtrado.
    expect(elements.some((e) => e.name === 'offscreen')).toBe(false);
  });

  it('marks elements sensitive by name (password/senha/passcode)', async () => {
    jxaResponse({
      title: 't',
      elements: [
        { ...ELEMENT, role: 'AXTextField', name: 'Senha do banco', value: 'x' },
      ],
    });
    const { elements } = await desktopControl.listElements('App');
    expect(elements[0]!.sensitive).toBe(true);
    // Campo sensível por nome também não carrega valor para o Jev.
    expect(elements[0]).not.toHaveProperty('value');
  });

  it('redacts secrets from names and values before leaving the adapter', async () => {
    jxaResponse({
      title: 't',
      elements: [
        {
          ...ELEMENT,
          role: 'AXTextField',
          name: `token: ${'x'.repeat(0)}apikey_${'a'.repeat(25)}`,
          value: `ghp_${'b'.repeat(25)}`,
        },
      ],
    });
    const { elements } = await desktopControl.listElements('App');
    expect(elements[0]!.name).not.toContain('apikey_aaa');
    expect(elements[0]!.value).not.toContain('ghp_');
  });

  it('press resolves the element by role+name+frame with ±4pt tolerance', async () => {
    jxaResponse({ ok: true });
    await desktopControl.press('App', {
      role: 'AXButton',
      name: 'Save',
      frame: { x: 102, y: 198, w: 80, h: 30 },
    });
    const { args } = lastCall();
    const argv = argvOf(args);
    expect(argv[0]).toBe('App');
    const target = JSON.parse(argv[1]!) as { role: string; name: string };
    expect(target.role).toBe('AXButton');
    expect(target.name).toBe('Save');
    expect(argv[2]).toBe('press');
    expect(scriptOf(args)).toContain('AXPress');
  });

  it('press throws DesktopElementGone when the match fails', async () => {
    jxaResponse({ ok: false, gone: true });
    await expect(
      desktopControl.press('App', {
        role: 'AXButton',
        name: 'Save',
        frame: { x: 0, y: 0, w: 10, h: 10 },
      }),
    ).rejects.toBeInstanceOf(DesktopElementGone);
  });

  it('doubleClick uses mode double (two presses within 150 ms)', async () => {
    jxaResponse({ ok: true });
    await desktopControl.doubleClick('App', {
      role: 'AXRow',
      name: 'file.txt',
      frame: { x: 1, y: 2, w: 10, h: 10 },
    });
    const { args } = lastCall();
    expect(argvOf(args)[2]).toBe('double');
    expect(scriptOf(args)).toContain('0.15');
  });

  it('setValue throws DesktopSensitiveField for secure fields', async () => {
    jxaResponse({ ok: false, sensitive: true });
    await expect(
      desktopControl.setValue(
        'App',
        { role: 'AXSecureTextField', name: 'Password', frame: { x: 0, y: 0, w: 1, h: 1 } },
        'texto',
      ),
    ).rejects.toBeInstanceOf(DesktopSensitiveField);
  });

  it('setValue falls back to keystroke and restores the clipboard for non-ASCII', async () => {
    jxaResponse({ ok: true, verified: false });
    await desktopControl.setValue(
      'App',
      { role: 'AXTextField', name: 'Nome', frame: { x: 0, y: 0, w: 1, h: 1 } },
      'José ñoño',
    );
    const { args } = lastCall();
    const script = scriptOf(args);
    expect(argvOf(args)[2]).toBe('José ñoño');
    expect(script).toContain('setTheClipboardTo');
    expect(script).toContain('command down');
  });

  it('pressKey maps names to macOS key codes and pins the target app', async () => {
    jxaResponse({ ok: true });
    await desktopControl.pressKey('App', 'enter');
    expect(argvOf(lastCall().args)).toEqual(['App', '36']);
    await desktopControl.pressKey('App', 'escape');
    expect(argvOf(lastCall().args)).toEqual(['App', '53']);
    await desktopControl.pressKey('App', 'pagedown');
    expect(argvOf(lastCall().args)).toEqual(['App', '121']);
  });

  it('pressKey recusa quando o app alvo perdeu o foco — nada digita no vizinho', async () => {
    jxaResponse({ ok: false, focus_lost: true });
    await expect(desktopControl.pressKey('App', 'enter')).rejects.toThrow();
  });

  it('captureWindow matches the window title and reports px→pt scale', async () => {
    jxaResponse({ title: 'Finder — Home', x: 10, y: 20, w: 400, h: 300 });
    // PNG de 800x600 (2x): largura nos bytes 16..19.
    const png = Buffer.alloc(24);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(600, 20);
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      {
        name: 'Finder — Home',
        thumbnail: { toPNG: () => png },
      },
    ] as never);
    const capture = await desktopControl.captureWindow('Finder');
    expect(capture).not.toBeNull();
    expect(capture!.frame).toEqual({ x: 10, y: 20, w: 400, h: 300 });
    expect(capture!.scale).toBe(2);
    expect(desktopCapturer.getSources).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['window'],
        thumbnailSize: { width: 800, height: 600 },
      }),
    );
  });

  it('captureWindow returns null when no source matches', async () => {
    jxaResponse({ title: 'X', x: 0, y: 0, w: 100, h: 100 });
    vi.mocked(desktopCapturer.getSources).mockResolvedValue([
      { name: 'Other', thumbnail: { toPNG: () => Buffer.alloc(24) } },
    ] as never);
    expect(await desktopControl.captureWindow('App')).toBeNull();
  });

  it('throws DesktopControlUnsupported off darwin', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(() => desktopControl.accessibilityStatus()).toThrow(
        DesktopControlUnsupported,
      );
      await expect(desktopControl.frontmostApp()).rejects.toBeInstanceOf(
        DesktopControlUnsupported,
      );
      await expect(desktopControl.listElements('App')).rejects.toBeInstanceOf(
        DesktopControlUnsupported,
      );
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('accessibilityStatus and requestAccessibility use isTrustedAccessibilityClient', () => {
    vi.mocked(systemPreferences.isTrustedAccessibilityClient).mockReturnValue(false);
    expect(desktopControl.accessibilityStatus()).toBe('denied');
    expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
    vi.mocked(systemPreferences.isTrustedAccessibilityClient).mockReturnValue(true);
    expect(desktopControl.requestAccessibility()).toBe('granted');
    expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
  });
});
