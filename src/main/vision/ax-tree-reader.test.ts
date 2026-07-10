import { describe, expect, it, vi } from 'vitest';
import type { AxNode } from '../../shared/vision-ipc';
import {
  performNexusAxAction,
  readNexusAxTree,
  selectNexusWindow,
  summarizeAxTree,
} from './ax-tree-reader';

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

describe('readNexusAxTree', () => {
  it('executes only in the explicitly authorized WebContents', async () => {
    const tree = node('body', null, [node('button', 'Projeto A')]);
    const ownerA = {
      id: 1,
      isDestroyed: () => false,
      isCrashed: () => false,
      executeJavaScript: vi.fn(async () => tree),
    };
    const ownerB = {
      id: 2,
      isDestroyed: () => false,
      isCrashed: () => false,
      executeJavaScript: vi.fn(async () => node('body', null)),
    };

    await expect(readNexusAxTree(ownerA as never)).resolves.toEqual(tree);
    expect(ownerA.executeJavaScript).toHaveBeenCalledOnce();
    expect(ownerB.executeJavaScript).not.toHaveBeenCalled();
  });

  it('fails before executing in a destroyed or crashed owner', async () => {
    const executeJavaScript = vi.fn();
    const owner = {
      id: 1,
      isDestroyed: () => true,
      isCrashed: () => false,
      executeJavaScript,
    };

    await expect(readNexusAxTree(owner as never)).rejects.toThrow(
      'não está mais disponível',
    );
    expect(executeJavaScript).not.toHaveBeenCalled();
  });
});

describe('performNexusAxAction', () => {
  it('executes a fresh ref only in the WebContents that produced it', async () => {
    const tree = {
      tag: 'body',
      role: null,
      aria: {},
      text: null,
      children: [
        { tag: 'button', role: null, aria: {}, text: 'Start', ref: 'u12e1', children: [] },
      ],
    };
    const ownerA = {
      id: 1,
      isDestroyed: () => false,
      isCrashed: () => false,
      executeJavaScript: vi
        .fn()
        .mockResolvedValueOnce(tree)
        .mockResolvedValueOnce({ ok: true, action: 'click', ref: 'u12e1' }),
    };
    const ownerB = {
      id: 2,
      isDestroyed: () => false,
      isCrashed: () => false,
      executeJavaScript: vi.fn(),
    };

    await readNexusAxTree(ownerA as never);
    await expect(
      performNexusAxAction(ownerB as never, { action: 'click', ref: 'u12e1' }),
    ).resolves.toMatchObject({ ok: false, error: 'stale_ref' });
    await expect(
      performNexusAxAction(ownerA as never, { action: 'click', ref: 'u12e1' }),
    ).resolves.toEqual({ ok: true, action: 'click', ref: 'u12e1' });
    expect(ownerB.executeJavaScript).not.toHaveBeenCalled();
  });

  it('fails before executing when the exact owner is no longer healthy', async () => {
    const executeJavaScript = vi.fn();
    const owner = {
      id: 1,
      isDestroyed: () => true,
      isCrashed: () => false,
      executeJavaScript,
    };

    await expect(
      performNexusAxAction(owner as never, { action: 'click', ref: 'u12e1' }),
    ).rejects.toThrow(/no longer available/i);
    expect(executeJavaScript).not.toHaveBeenCalled();
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
