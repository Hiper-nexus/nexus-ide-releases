/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCatalogResource } from './use-catalog-resource';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let resource: ReturnType<typeof useCatalogResource<string[]>>;

function deferred() {
  let resolve!: (value: string[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string[]>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mount(read: () => Promise<string[]>) {
  function Probe() { resource = useCatalogResource(read, 'Falha ao ler catálogo.'); return null; }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
}

afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); });

describe('catalog request ordering', () => {
  it('keeps the latest reload when an older read finishes later', async () => {
    const old = deferred();
    const latest = deferred();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    mount(read);
    act(() => { void resource.reload(); });
    await act(async () => { latest.resolve(['current']); await latest.promise; });
    await act(async () => { old.resolve(['obsolete']); await old.promise; });
    expect(resource.data).toEqual(['current']);
    expect(resource.loading).toBe(false);
    expect(resource.error).toBeNull();
  });

  it('keeps generated descriptions when the initial cache read subsequently fails', async () => {
    const pending = deferred();
    mount(() => pending.promise);
    act(() => resource.accept(['generated']));
    await act(async () => { pending.reject(new Error('outdated cache')); await pending.promise.catch(() => {}); });
    expect(resource.data).toEqual(['generated']);
    expect(resource.error).toBeNull();
    expect(resource.loading).toBe(false);
  });

  it('retains valid data while exposing a refresh failure and allowing another retry', async () => {
    const read = vi.fn().mockResolvedValueOnce(['cached']).mockRejectedValueOnce(new Error('private')).mockResolvedValueOnce(['fresh']);
    await act(async () => mount(read));
    await act(async () => resource.reload());
    expect(resource.data).toEqual(['cached']);
    expect(resource.error).toBe('Falha ao ler catálogo.');
    await act(async () => resource.reload());
    expect(resource.data).toEqual(['fresh']);
    expect(resource.error).toBeNull();
  });
});
