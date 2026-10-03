import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateModelCatalogCache, loadModelCatalog, loadModelCatalogAsync, refreshRemoteModelCatalog } from './model-catalog';

const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-async-')); dirs.push(dir); return path.join(dir, 'catalog.json'); };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('asynchronous periodic catalog IO', () => {
  it('preserves normal catalog merge semantics without synchronous filesystem reads', async () => {
    const file = temp();
    fs.writeFileSync(file, JSON.stringify({ adapters: { codex: { default: 'operator-model' } } }));
    const expected = loadModelCatalog(file);
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('sync IO'); });
    expect(await loadModelCatalogAsync(file)).toEqual(expected);
    expect(read).not.toHaveBeenCalled();
  });
  it('does not write an old refresh after catalog configuration was invalidated', async () => {
    const file = temp();
    fs.writeFileSync(file, 'original');
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((yes) => { resolve = yes; })));
    const pending = refreshRemoteModelCatalog('https://example.test/catalog', file);
    invalidateModelCatalogCache();
    resolve(new Response(JSON.stringify({ adapters: { codex: { default: 'stale-model' } } })));
    expect(await pending).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });
  it('rejects oversized remote catalog bodies before parsing or persistence', async () => {
    const file = temp();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      adapters: { codex: { default: 'model' } }, padding: ' '.repeat(4 * 1024 * 1024),
    }))));
    expect(await refreshRemoteModelCatalog('https://example.test/catalog', file)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});
