/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_SANS_FONT_STACK,
  appearanceFontStack,
  applyAppearanceFontVariables,
  clampCodeFontSize,
  clampInterfaceFontSize,
  cssFontFamilies,
  discoverInstalledFonts,
  queryInstalledFontFamilies,
  readFontEnumeration,
  resetFontEnumeration,
  resetInstalledFontFamiliesCache,
  subscribeFontEnumeration,
} from './appearance-fonts';

beforeEach(() => {
  resetFontEnumeration();
  resetInstalledFontFamiliesCache();
});

afterEach(() => {
  resetFontEnumeration();
  resetInstalledFontFamiliesCache();
  vi.unstubAllGlobals();
});

describe('cssFontFamilies', () => {
  it('returns null for empty or whitespace input', () => {
    expect(cssFontFamilies('')).toBeNull();
    expect(cssFontFamilies('   ')).toBeNull();
    expect(cssFontFamilies(' , , ')).toBeNull();
  });

  it('keeps simple idents unquoted and quotes names with spaces', () => {
    expect(cssFontFamilies('Inter')).toBe('Inter');
    expect(cssFontFamilies('JetBrains Mono')).toBe('"JetBrains Mono"');
    expect(cssFontFamilies('SF Pro Text, Menlo')).toBe('"SF Pro Text", Menlo');
  });

  it('strips embedded double quotes so the CSS list stays valid', () => {
    expect(cssFontFamilies('Weird "Name"')).toBe('"Weird Name"');
  });
});

describe('appearanceFontStack', () => {
  it('keeps the default stack when no custom family is set', () => {
    expect(appearanceFontStack('', DEFAULT_CODE_FONT_STACK)).toBe(DEFAULT_CODE_FONT_STACK);
  });

  it('prepends the custom family so glyph coverage never regresses', () => {
    expect(appearanceFontStack('Fira Code', DEFAULT_CODE_FONT_STACK)).toBe(
      `"Fira Code", ${DEFAULT_CODE_FONT_STACK}`,
    );
    expect(appearanceFontStack('InterTight', DEFAULT_SANS_FONT_STACK)).toBe(
      `InterTight, ${DEFAULT_SANS_FONT_STACK}`,
    );
  });
});

describe('size clamps', () => {
  it('clamps interface and code sizes to their ranges', () => {
    expect(clampInterfaceFontSize(3)).toBe(11);
    expect(clampInterfaceFontSize(99)).toBe(20);
    expect(clampInterfaceFontSize(Number.NaN)).toBe(DEFAULT_INTERFACE_FONT_SIZE);
    expect(clampCodeFontSize(2)).toBe(9);
    expect(clampCodeFontSize(40)).toBe(24);
    expect(clampCodeFontSize(Number.NaN)).toBe(DEFAULT_CODE_FONT_SIZE);
  });
});

describe('applyAppearanceFontVariables', () => {
  function root(): HTMLElement {
    return document.documentElement;
  }

  it('writes custom families prepended to the shared default stacks', () => {
    applyAppearanceFontVariables(root(), {
      interfaceFamily: 'Inter Tight',
      codeFamily: 'Fira Code',
      interfaceSize: DEFAULT_INTERFACE_FONT_SIZE,
      codeSize: DEFAULT_CODE_FONT_SIZE,
    });
    expect(root().style.getPropertyValue('--font-ui')).toBe(
      `"Inter Tight", ${DEFAULT_SANS_FONT_STACK}`,
    );
    expect(root().style.getPropertyValue('--font-mono')).toBe(
      `"Fira Code", ${DEFAULT_CODE_FONT_STACK}`,
    );
  });

  it('removes family overrides when unset so base.css stays in charge', () => {
    const el = root();
    el.style.setProperty('--font-ui', 'stale');
    el.style.setProperty('--font-mono', 'stale');
    applyAppearanceFontVariables(el, {
      interfaceFamily: '',
      codeFamily: '  ',
      interfaceSize: DEFAULT_INTERFACE_FONT_SIZE,
      codeSize: DEFAULT_CODE_FONT_SIZE,
    });
    expect(el.style.getPropertyValue('--font-ui')).toBe('');
    expect(el.style.getPropertyValue('--font-mono')).toBe('');
  });

  it('scales the type ramp only away from the default interface size', () => {
    const el = root();
    applyAppearanceFontVariables(el, {
      interfaceFamily: '',
      codeFamily: '',
      interfaceSize: 16,
      codeSize: 15,
    });
    expect(el.style.getPropertyValue('--text-md')).toBe('16px');
    expect(el.style.getPropertyValue('--font-size-code')).toBe('15px');
    expect(el.style.getPropertyValue('--font-size-interface')).toBe('16px');

    applyAppearanceFontVariables(el, {
      interfaceFamily: '',
      codeFamily: '',
      interfaceSize: DEFAULT_INTERFACE_FONT_SIZE,
      codeSize: DEFAULT_CODE_FONT_SIZE,
    });
    expect(el.style.getPropertyValue('--text-md')).toBe('');
    expect(el.style.getPropertyValue('--font-size-code')).toBe('13px');
  });
});

describe('queryInstalledFontFamilies', () => {
  it('reports unsupported when the engine has no queryLocalFonts', async () => {
    const result = await queryInstalledFontFamilies();
    expect(result.status).toBe('unsupported');
    expect(result.families).toEqual([]);
  });

  it('collects unique sorted families and drops OS-internal faces', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [
      { family: 'Menlo' },
      { family: '.AppleSystemUIFont' },
      { family: 'Fira Code' },
      { family: 'Menlo' },
    ]);
    const result = await queryInstalledFontFamilies();
    expect(result.status).toBe('granted');
    expect(result.families).toEqual(['Fira Code', 'Menlo']);
  });

  it('treats an empty list or a throw as denied', async () => {
    vi.stubGlobal('queryLocalFonts', async () => []);
    expect((await queryInstalledFontFamilies()).status).toBe('denied');
    resetInstalledFontFamiliesCache();
    vi.stubGlobal('queryLocalFonts', async () => {
      throw new Error('denied');
    });
    expect((await queryInstalledFontFamilies()).status).toBe('denied');
  });
});

describe('shared font enumeration', () => {
  it('propagates one discovery to every subscriber', async () => {
    vi.stubGlobal('queryLocalFonts', async () => [{ family: 'Menlo' }]);
    resetFontEnumeration();
    expect(readFontEnumeration().status).toBe('unknown');
    const seen: string[] = [];
    const unsubscribe = subscribeFontEnumeration(() => {
      seen.push(readFontEnumeration().status);
    });
    discoverInstalledFonts();
    discoverInstalledFonts();
    await vi.waitFor(() => expect(readFontEnumeration().status).toBe('granted'));
    expect(seen).toEqual(['granted']);
    unsubscribe();
  });

  it('flips to unavailable when the query fails', async () => {
    vi.stubGlobal('queryLocalFonts', async () => {
      throw new Error('nope');
    });
    resetFontEnumeration();
    discoverInstalledFonts();
    await vi.waitFor(() => expect(readFontEnumeration().status).toBe('unavailable'));
  });
});

describe('cssFontFamilies — sanitização', () => {
  it('remove ; { } <> e caracteres de controle do nome da fonte', () => {
    expect(cssFontFamilies('Evil; color: red')).toBe('"Evil color: red"');
    expect(cssFontFamilies('a}b{c')).toBe('abc');
    expect(cssFontFamilies('x\u0000y')).toBe('xy');
  });
});
