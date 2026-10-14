import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROK_AUTH_WRITE_THROUGH_POLICY as policy } from './cli-mcp-session-grok';
import {
  decideAuthWriteThrough,
  startAuthWriteThrough,
  writeThroughOnce,
} from './overlay-auth-writethrough';

const ACCOUNT = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const grokAuth = (refresh: string, expiresAt: string, key = ACCOUNT, email = 'op@example.com') =>
  JSON.stringify({ [key]: { email, refresh_token: refresh, expires_at: expiresAt } });

const NOW = Date.parse('2026-09-29T12:00:00Z');
const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-auth-wt-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Windows: a gravação na origem falha por compartilhamento (antivírus,
 * indexador, outro processo com o arquivo aberto) — EPERM/EBUSY — e passa
 * depois. Só o arquivo de origem falha; o resto do fs segue real.
 */
function failSourceWrites(sourceFile: string, codes: string[]): void {
  const realOpen = fs.openSync.bind(fs);
  vi.spyOn(fs, 'openSync').mockImplementation(((
    file: fs.PathLike,
    flags: fs.OpenMode = 'r',
    mode?: fs.Mode | null,
  ) => {
    if (typeof file === 'string' && path.resolve(file) === path.resolve(sourceFile) && codes.length > 0) {
      const code = codes.shift()!;
      throw Object.assign(new Error(`${code}: operation not permitted (simulado)`), { code });
    }
    return realOpen(file, flags, mode);
  }) as typeof fs.openSync);
}

/** O Grok regrava o auth.json por temporário + rename (desfaz o hardlink). */
function cliRenameWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

describe('devolução do auth.json renovado ao perfil de origem (F-684)', () => {
  it('mesma conta: só o blob mais novo volta; nunca um mais velho', () => {
    const old = grokAuth('r1', '2026-09-23T01:59:00Z');
    const fresh = grokAuth('r2', '2026-09-29T18:00:00Z');
    expect(decideAuthWriteThrough(fresh, old, policy, NOW)).toBe('write');
    expect(decideAuthWriteThrough(old, fresh, policy, NOW)).toBe('skip');
    expect(decideAuthWriteThrough(fresh, fresh, policy, NOW)).toBe('skip');
  });

  it('login novo no pane com a origem vazia é persistido', () => {
    expect(decideAuthWriteThrough(grokAuth('r1', '2026-09-29T18:00:00Z'), null, policy, NOW)).toBe('write');
  });

  it('outra conta nunca pisa num login válido; só substitui origem vencida', () => {
    const other = grokAuth('rx', '2026-09-29T18:00:00Z', 'https://auth.x.ai::outra', 'outra@example.com');
    expect(decideAuthWriteThrough(other, grokAuth('r1', '2026-09-29T15:00:00Z'), policy, NOW)).toBe('skip');
    expect(decideAuthWriteThrough(other, grokAuth('r1', '2026-09-23T01:59:00Z'), policy, NOW)).toBe('write');
  });

  it('blob ilegível no overlay nunca vai para a origem', () => {
    expect(decideAuthWriteThrough('{quebrado', grokAuth('r1', '2026-09-23T01:59:00Z'), policy, NOW)).toBe('skip');
  });

  it('Windows: rename da CLI desfaz o hardlink; o token novo volta NO arquivo de origem e alcança o outro pane', () => {
    const native = tempDir();
    const paneA = tempDir();
    const paneB = tempDir();
    const source = path.join(native, 'auth.json');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.linkSync(source, path.join(paneA, 'auth.json'));
    fs.linkSync(source, path.join(paneB, 'auth.json'));

    const renewed = grokAuth('r2', '2026-09-29T18:00:00Z');
    cliRenameWrite(path.join(paneA, 'auth.json'), renewed);
    expect(fs.readFileSync(source, 'utf8')).not.toBe(renewed);

    expect(writeThroughOnce(path.join(paneA, 'auth.json'), source, policy, NOW)).toBe(true);
    expect(fs.readFileSync(source, 'utf8')).toBe(renewed);
    // Gravação no próprio arquivo: o pane B, ainda no hardlink, vê o token novo.
    expect(fs.readFileSync(path.join(paneB, 'auth.json'), 'utf8')).toBe(renewed);
  });

  it('o disposer faz a última passada ao fechar o pane', () => {
    const native = tempDir();
    const pane = tempDir();
    const source = path.join(native, 'auth.json');
    const overlay = path.join(pane, 'auth.json');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.copyFileSync(source, overlay);
    const stop = startAuthWriteThrough({ overlayFile: overlay, sourceFile: source, policy, intervalMs: 60_000 });
    const renewed = grokAuth('r3', '2099-01-01T00:00:00Z');
    cliRenameWrite(overlay, renewed);
    stop();
    expect(fs.readFileSync(source, 'utf8')).toBe(renewed);
  });
});

describe('F-1485: a renovação do Grok não se perde no Windows e só volta para a conta do pane', () => {
  const OTHER = 'https://auth.x.ai::outra-conta';
  /** Pane com overlay copiado da origem e vigia ligado. */
  function pane(sourceBlob: string | null, intervalMs = 60_000, verifyDestination?: (file: string) => boolean) {
    const native = tempDir();
    const dir = tempDir();
    const source = path.join(native, 'auth.json');
    const overlay = path.join(dir, 'auth.json');
    if (sourceBlob !== null) {
      fs.writeFileSync(source, sourceBlob);
      fs.copyFileSync(source, overlay);
    }
    const stop = startAuthWriteThrough({ overlayFile: overlay, sourceFile: source, policy, intervalMs, verifyDestination });
    return { native, dir, source, overlay, stop };
  }

  it('Windows: gravação na origem recusada (EPERM, depois EBUSY) é tentada de novo sem nova mudança no overlay; o lock da CLI fica intacto', async () => {
    const native = tempDir();
    const dir = tempDir();
    const source = path.join(native, 'auth.json');
    const overlay = path.join(dir, 'auth.json');
    const lock = path.join(native, 'auth.json.lock');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.writeFileSync(lock, '42752 1791933621');
    fs.linkSync(source, overlay);
    fs.linkSync(lock, path.join(dir, 'auth.json.lock'));
    const stop = startAuthWriteThrough({ overlayFile: overlay, sourceFile: source, policy, intervalMs: 20 });
    try {
      failSourceWrites(source, ['EPERM', 'EBUSY']);
      const renewed = grokAuth('r2', '2099-01-01T00:00:00Z');
      cliRenameWrite(overlay, renewed);
      await vi.waitFor(() => expect(fs.readFileSync(source, 'utf8')).toBe(renewed), { timeout: 2_000, interval: 20 });
      expect(fs.readFileSync(lock, 'utf8')).toBe('42752 1791933621');
    } finally {
      stop();
    }
  });

  it('fechamento com a origem ocupada: a renovação é regravada da memória mesmo com o overlay já apagado', async () => {
    const p = pane(grokAuth('r1', '2026-09-23T01:59:00Z'), 20);
    failSourceWrites(p.source, ['EBUSY', 'EPERM', 'EBUSY']);
    const renewed = grokAuth('r3', '2099-01-01T00:00:00Z');
    cliRenameWrite(p.overlay, renewed);
    p.stop();
    fs.rmSync(p.dir, { recursive: true, force: true });
    await vi.waitFor(() => expect(fs.readFileSync(p.source, 'utf8')).toBe(renewed), { timeout: 2_000, interval: 20 });
  });

  it('gravação no próprio arquivo: o inode da origem não muda (os hardlinks dos outros panes veem o token)', () => {
    const p = pane(grokAuth('r1', '2026-09-23T01:59:00Z'));
    const before = fs.statSync(p.source).ino;
    cliRenameWrite(p.overlay, grokAuth('r2', '2099-01-01T00:00:00Z'));
    p.stop();
    expect(fs.statSync(p.source).ino).toBe(before);
  });

  it('o vigia vivo nunca grava a conta B no perfil vazio da conta A do pane', () => {
    const p = pane(grokAuth('r1', '2026-09-23T01:59:00Z'));
    // Origem raspada (managed home vazio) e login de outra conta dentro do pane.
    fs.rmSync(p.source);
    cliRenameWrite(p.overlay, grokAuth('rb', '2099-01-01T00:00:00Z', OTHER, 'b@example.com'));
    p.stop();
    expect(fs.existsSync(p.source)).toBe(false);
  });

  it('login de outra conta no pane não troca a conta da origem, nem vencida', () => {
    const expired = grokAuth('r1', '2026-09-23T01:59:00Z');
    const p = pane(expired);
    cliRenameWrite(p.overlay, grokAuth('rb', '2099-01-01T00:00:00Z', OTHER, 'b@example.com'));
    p.stop();
    expect(fs.readFileSync(p.source, 'utf8')).toBe(expired);
  });

  it('origem com JSON parcial não bloqueia devolver a renovação da conta do pane', () => {
    const p = pane(grokAuth('r1', '2026-09-23T01:59:00Z'));
    const renewed = grokAuth('r2', '2099-01-01T00:00:00Z');
    fs.writeFileSync(p.source, '{"https://auth.x.ai::b1a00492');
    cliRenameWrite(p.overlay, renewed);
    p.stop();
    expect(fs.readFileSync(p.source, 'utf8')).toBe(renewed);
  });

  it('pane que nasceu sem credencial só preenche origem vazia', () => {
    const p = pane(null);
    const login = grokAuth('r1', '2099-01-01T00:00:00Z');
    cliRenameWrite(p.overlay, login);
    p.stop();
    expect(fs.readFileSync(p.source, 'utf8')).toBe(login);
  });

  it('destino conferido antes E depois de abrir: trocado no meio, nada é gravado', () => {
    const verdicts = [true, false];
    const verify = vi.fn(() => verdicts.shift() ?? false);
    const old = grokAuth('r1', '2026-09-23T01:59:00Z');
    const p = pane(old, 60_000, verify);
    cliRenameWrite(p.overlay, grokAuth('r2', '2099-01-01T00:00:00Z'));
    p.stop();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(p.source, 'utf8')).toBe(old);
  });
});
