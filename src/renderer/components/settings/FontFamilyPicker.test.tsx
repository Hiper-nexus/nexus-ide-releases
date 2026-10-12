/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readFontEnumeration,
  resetFontEnumeration,
  resetInstalledFontFamiliesCache,
} from '../../styles/appearance-fonts';
import { FontFamilyPicker, FontSizePicker } from './FontFamilyPicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Wait for the shared enumeration to flip to granted, then flush React. */
async function awaitEnumerationGranted(): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => expect(readFontEnumeration().status).toBe('granted'));
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetFontEnumeration();
  resetInstalledFontFamiliesCache();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  resetFontEnumeration();
  resetInstalledFontFamiliesCache();
});

describe('FontFamilyPicker', () => {
  it('falls back to a typed input when the engine cannot enumerate fonts', () => {
    const onChange = vi.fn();
    const container = mount(
      <FontFamilyPicker
        id="ui"
        label="Interface"
        defaultLabel="Inter"
        value=""
        onChange={onChange}
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input).not.toBeNull();
    expect(container.querySelector('select')).toBeNull();
    setInputValue(input, 'Inter Tight');
    expect(onChange).toHaveBeenCalledWith('Inter Tight');
  });

  it('shares one enumeration across rows: select lists families once granted', async () => {
    vi.stubGlobal(
      'queryLocalFonts',
      vi.fn(async () => [{ family: 'Menlo' }, { family: 'Fira Code' }]),
    );
    resetFontEnumeration();
    const onChange = vi.fn();
    const container = mount(
      <>
        <FontFamilyPicker
          id="ui"
          label="Interface"
          defaultLabel="Inter"
          value=""
          onChange={vi.fn()}
        />
        <FontFamilyPicker
          id="code"
          label="Código"
          defaultLabel="JetBrains Mono"
          value=""
          onChange={onChange}
        />
      </>,
    );
    await awaitEnumerationGranted();
    expect(container.querySelectorAll('select')).toHaveLength(2);
    const options = Array.from(
      container.querySelectorAll<HTMLSelectElement>('select')[1]!.options,
    ).map((option) => option.value);
    expect(options).toContain('Menlo');
    expect(options).toContain('Fira Code');
    expect(options).toContain('__default__');
    expect(options).toContain('__custom__');

    setSelectValue(container.querySelectorAll<HTMLSelectElement>('select')[1]!, 'Fira Code');
    expect(onChange).toHaveBeenCalledWith('Fira Code');
  });

  it('opens a typed path for a family the enumeration does not list', async () => {
    vi.stubGlobal(
      'queryLocalFonts',
      vi.fn(async () => [{ family: 'Menlo' }]),
    );
    resetFontEnumeration();
    const onChange = vi.fn();
    const container = mount(
      <FontFamilyPicker
        id="term"
        label="Terminal"
        defaultLabel="JetBrains Mono"
        value="Comic Sans MS"
        onChange={onChange}
      />,
    );
    await awaitEnumerationGranted();
    expect(container.querySelector('select')).not.toBeNull();
    const select = container.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('__custom__');
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.value).toBe('Comic Sans MS');
    setInputValue(input, 'Fira Code');
    expect(onChange).toHaveBeenCalledWith('Fira Code');
  });

  it('resets to the default stack from the select', async () => {
    vi.stubGlobal(
      'queryLocalFonts',
      vi.fn(async () => [{ family: 'Menlo' }]),
    );
    resetFontEnumeration();
    const onChange = vi.fn();
    const container = mount(
      <FontFamilyPicker
        id="ui"
        label="Interface"
        defaultLabel="Inter"
        value="Menlo"
        onChange={onChange}
      />,
    );
    await awaitEnumerationGranted();
    expect(container.querySelector('select')).not.toBeNull();
    setSelectValue(container.querySelector<HTMLSelectElement>('select')!, '__default__');
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('FontSizePicker', () => {
  it('emits the range value', () => {
    const onChange = vi.fn();
    const container = mount(
      <FontSizePicker
        id="ui"
        label="Tamanho da interface"
        value={13}
        min={11}
        max={20}
        onChange={onChange}
      />,
    );
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(range.min).toBe('11');
    expect(range.max).toBe('20');
    setInputValue(range, '16');
    expect(onChange).toHaveBeenCalledWith(16);
  });
});
