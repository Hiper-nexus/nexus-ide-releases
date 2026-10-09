/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposerTiptapEditor } from './ComposerTiptapEditor';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('ComposerTiptapEditor value sync', () => {
  it('replaces the document when value changes after mount', () => {
    function Probe({ value }: { value: string }) {
      return <ComposerTiptapEditor value={value} />;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<Probe value="antes" />));
    expect(document.body.textContent).toContain('antes');
    act(() => root.render(<Probe value={'foo\nbar'} />));
    expect(document.body.textContent).toContain('foo');
    expect(document.body.textContent).toContain('bar');
    expect(document.body.textContent).not.toContain('antes');
  });
});
