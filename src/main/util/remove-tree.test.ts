import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeTree, removeTreeSync } from './remove-tree';

const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

function linksUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (fs.lstatSync(child).isSymbolicLink()) found.push(child);
      else if (entry.isDirectory()) walk(child);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

/** Overlay de pane com junction para conversas duráveis e hardlink de histórico. */
function overlayFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'nexus-remove-tree-'));
  const durable = path.join(root, 'provider-state', 'claude');
  const conversation = path.join(durable, 'projects', 'hipergo', 'conversa.jsonl');
  fs.mkdirSync(path.dirname(conversation), { recursive: true });
  fs.writeFileSync(conversation, '{"type":"user"}\n');
  fs.writeFileSync(path.join(durable, 'history.jsonl'), 'h\n');
  const overlay = path.join(root, 'ephemeral', 'tok');
  fs.mkdirSync(path.join(overlay, '.claude', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(overlay, '.claude', 'cache', 'x'), 'x');
  fs.symlinkSync(path.join(durable, 'projects'), path.join(overlay, '.claude', 'projects'), DIR_LINK);
  fs.linkSync(path.join(durable, 'history.jsonl'), path.join(overlay, '.claude', 'history.jsonl'));
  return { root, overlay, durable, conversation };
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('removeTree não segue link (F-663)', () => {
  it.each(['lstatSync', 'readdirSync'] as const)('não remove a árvore se %s falhar durante a inspeção', (operation) => {
    const fx = overlayFixture();
    roots.push(fx.root);
    const error = Object.assign(new Error('scan denied'), { code: 'EACCES' });
    vi.spyOn(fs, operation).mockImplementationOnce(() => { throw error; });
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
    expect(() => removeTreeSync(fx.overlay, { force: true })).toThrow(error);
    expect(rm).not.toHaveBeenCalled();
    expect(fs.existsSync(fx.conversation)).toBe(true);
  });

  it.each(['lstat', 'readdir'] as const)('não remove a árvore se %s async falhar durante a inspeção', async (operation) => {
    const fx = overlayFixture();
    roots.push(fx.root);
    const error = Object.assign(new Error('scan failed'), { code: 'EIO' });
    vi.spyOn(fs.promises, operation).mockRejectedValueOnce(error);
    const rm = vi.spyOn(fs.promises, 'rm').mockResolvedValue();
    await expect(removeTree(fx.overlay, { force: true })).rejects.toThrow(error);
    expect(rm).not.toHaveBeenCalled();
    expect(fs.existsSync(fx.conversation)).toBe(true);
  });

  it('apaga o overlay e preserva as conversas do outro lado da junction', () => {
    const fx = overlayFixture();
    roots.push(fx.root);
    removeTreeSync(fx.overlay, { force: true });
    expect(fs.existsSync(fx.overlay)).toBe(false);
    expect(fs.readFileSync(fx.conversation, 'utf8')).toContain('user');
    expect(fs.existsSync(path.join(fx.durable, 'history.jsonl'))).toBe(true);
  });

  it('o rm recursivo só roda depois que todo link da árvore saiu', () => {
    // No Electron 43 (Node 24) o rm recursivo atravessa junction no Windows e
    // apagou as conversas do operador; o Node 22 do vitest não faz isso, então
    // a prova é que o rm nunca recebe uma árvore que ainda contém link.
    const fx = overlayFixture();
    roots.push(fx.root);
    const realRm = fs.rmSync;
    const seen: string[][] = [];
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      seen.push(linksUnder(String(target)));
      realRm(target, options);
    });
    removeTreeSync(fx.overlay, { force: true });
    expect(seen).toEqual([[]]);
    expect(fs.existsSync(fx.conversation)).toBe(true);
  });

  it('versão assíncrona: mesmo contrato', async () => {
    const fx = overlayFixture();
    roots.push(fx.root);
    const realRm = fs.promises.rm;
    const seen: string[][] = [];
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      seen.push(linksUnder(String(target)));
      await realRm(target, options);
    });
    await removeTree(fx.overlay, { force: true });
    expect(seen).toEqual([[]]);
    expect(fs.existsSync(fx.overlay)).toBe(false);
    expect(fs.existsSync(fx.conversation)).toBe(true);
  });

  it('alvo que é o próprio link: só o link sai', () => {
    const fx = overlayFixture();
    roots.push(fx.root);
    const link = path.join(fx.overlay, '.claude', 'projects');
    removeTreeSync(link, { force: true });
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(fx.conversation)).toBe(true);
  });

  it.each(['sync', 'async'] as const)('alvo symlink com force:false não falha depois de remover o link (%s)', async (mode) => {
    const fx = overlayFixture();
    roots.push(fx.root);
    const link = path.join(fx.overlay, '.claude', 'projects');
    if (mode === 'sync') removeTreeSync(link, { force: false });
    else await removeTree(link, { force: false });
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(fx.conversation)).toBe(true);
  });

  it('alvo inexistente com force não falha', () => {
    expect(() => removeTreeSync(path.join(os.tmpdir(), 'nexus-nao-existe-f663'), { force: true })).not.toThrow();
  });
});
