import { describe, expect, it, vi } from 'vitest';
import { assertInspectableBrowserDom } from './browser-visual-inspection';
describe('closed browser components', () => {
  it('rejects deeply nested raw DOM before recursive parsing can exhaust Main', async () => {
    let root: { children?: unknown[] } = {};
    for (let index = 0; index < 300; index++) root = { children: [root] };
    const inspector = { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({ root })) };
    await expect(assertInspectableBrowserDom(inspector)).rejects.toThrow('depth limit');
    expect(inspector.detach).toHaveBeenCalledOnce();
  });
  it('blocks closed roots including nested or overflowing opaque components and detaches its own inspector', async () => {
    const inspector = { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({
      root: { nodeType: 1, children: [{ shadowRoots: [{ shadowRootType: 'open', children: [{ shadowRoots: [{ shadowRootType: 'closed' }] }] }] }] },
    })) };
    await expect(assertInspectableBrowserDom(inspector)).rejects.toThrow('closed');
    expect(inspector.detach).toHaveBeenCalledOnce();
    const existing = { ...inspector, isAttached: () => true };
    inspector.detach.mockClear();
    await expect(assertInspectableBrowserDom(existing)).rejects.toThrow('inspector');
    expect(inspector.detach).not.toHaveBeenCalled();
  });
  it('permits inspectable pages and native browser controls, but rejects unavailable inspection', async () => {
    const inspector = { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({
      root: { shadowRoots: [{ shadowRootType: 'user-agent' }] },
    })) };
    await expect(assertInspectableBrowserDom(inspector)).resolves.toBeUndefined();
    inspector.sendCommand.mockRejectedValueOnce(new Error('closed inspector unavailable'));
    await expect(assertInspectableBrowserDom(inspector)).rejects.toThrow();
  });
});
