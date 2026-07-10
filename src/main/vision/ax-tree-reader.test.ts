import { describe, expect, it } from 'vitest';
import type { AxNode } from '../../shared/vision-ipc';
import { selectNexusWindow, summarizeAxTree } from './ax-tree-reader';

function windowCandidate(options: { destroyed?: boolean; crashed?: boolean } = {}) {
  return {
    isDestroyed: () => options.destroyed ?? false,
    webContents: {
      isDestroyed: () => options.destroyed ?? false,
      isCrashed: () => options.crashed ?? false,
    },
  };
}

describe('selectNexusWindow', () => {
  it('prefers a healthy focused Nexus window', () => {
    const focused = windowCandidate();
    const other = windowCandidate();

    expect(selectNexusWindow(focused, [focused, other])).toBe(focused);
  });

  it('keeps global Jarvis reads working when the sole Nexus window is unfocused', () => {
    const onlyWindow = windowCandidate();

    expect(selectNexusWindow(null, [onlyWindow])).toBe(onlyWindow);
  });

  it('fails closed for ambiguous or unhealthy fallback windows', () => {
    const healthyA = windowCandidate();
    const healthyB = windowCandidate();
    const crashed = windowCandidate({ crashed: true });

    expect(selectNexusWindow(null, [healthyA, healthyB])).toBeNull();
    expect(selectNexusWindow(null, [crashed])).toBeNull();
  });
});

const node = (
  tag: string,
  text: string | null,
  children: AxNode[] = [],
  aria: Record<string, string> = {},
): AxNode => ({ tag, role: null, aria, text, children });

describe('summarizeAxTree', () => {
  it('keeps visible labels, hierarchy, and interactive state', () => {
    const summary = summarizeAxTree(
      node('body', null, [
        node('nav', null, [node('button', 'Configurações', [], { selected: 'true' })]),
        node('section', 'Provider Gemini Live'),
      ]),
    );

    expect(summary.text).toContain('button selected=true: Configurações');
    expect(summary.text).toContain('section: Provider Gemini Live');
    expect(summary.nodeCount).toBe(4);
    expect(summary.truncated).toBe(false);
  });

  it('bounds a pathological page tree', () => {
    const children = Array.from({ length: 400 }, (_, index) =>
      node('div', `linha ${index} ${'x'.repeat(800)}`),
    );
    const summary = summarizeAxTree(node('body', null, children));

    expect(summary.nodeCount).toBeLessThanOrEqual(240);
    expect(summary.text.length).toBeLessThanOrEqual(20_000);
    expect(summary.truncated).toBe(true);
  });
});
