import { EventEmitter } from 'node:events';
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

/**
 * Dois testes abaixo dependem de um evento REAL do fs.watch. No macOS (FSEvents)
 * o evento é PERDIDO quando outros processos agitam o disco (várias panes
 * compilando): medido na base 310b0f75a e em HEAD com a mesma taxa, 7 de 30
 * execuções sob carga esperavam 2 s por um evento que nunca chegou. Não é
 * atraso (com 12 s de prazo os falhos esperavam os 12 s inteiros), então prazo
 * maior não ajuda: repete a tentativa. Em produção essa perda é coberta pela
 * rede de segurança do vigia (SAFETY_STAT_MS), testada com timers falsos no
 * bloco do M2, sem depender do SO.
 */
const REAL_WATCH_EVENT_RETRIES = 3;

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

  it('vigia por fs.watch: sem poll de statSync ocioso, e a renovação volta sem esperar o intervalo', { retry: REAL_WATCH_EVENT_RETRIES }, async () => {
    const native = tempDir();
    const paneDir = tempDir();
    const source = path.join(native, 'auth.json');
    const overlay = path.join(paneDir, 'auth.json');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.copyFileSync(source, overlay);
    const watch = vi.spyOn(fs, 'watch');
    const interval = vi.spyOn(globalThis, 'setInterval');
    // Intervalo enorme: se a devolução depender do poll, o teste estoura o waitFor.
    const stop = startAuthWriteThrough({ overlayFile: overlay, sourceFile: source, policy, intervalMs: 600_000 });
    try {
      expect(watch).toHaveBeenCalledTimes(1);
      expect(String(watch.mock.calls[0][0])).toBe(path.dirname(overlay));
      // Sem poll de statSync ocioso no ritmo do vigia: o único temporizador é a
      // rede de segurança lenta (30–60 s), nunca o intervalMs.
      expect(interval).toHaveBeenCalledTimes(1);
      expect(interval.mock.calls[0][1]).toBeGreaterThanOrEqual(30_000);
      expect(interval.mock.calls[0][1]).toBeLessThanOrEqual(60_000);
      const renewed = grokAuth('r9', '2099-01-01T00:00:00Z');
      cliRenameWrite(overlay, renewed);
      await vi.waitFor(() => expect(fs.readFileSync(source, 'utf8')).toBe(renewed), { timeout: 2_000, interval: 20 });
    } finally {
      stop();
    }
  });

  it('sem fs.watch (lança ao abrir), volta ao poll por intervalo', async () => {
    const native = tempDir();
    const paneDir = tempDir();
    const source = path.join(native, 'auth.json');
    const overlay = path.join(paneDir, 'auth.json');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.copyFileSync(source, overlay);
    vi.spyOn(fs, 'watch').mockImplementation(() => { throw new Error('EPERM: watch indisponível (simulado)'); });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const stop = startAuthWriteThrough({ overlayFile: overlay, sourceFile: source, policy, intervalMs: 20 });
    try {
      expect(interval).toHaveBeenCalledTimes(1);
      const renewed = grokAuth('r9', '2099-01-01T00:00:00Z');
      cliRenameWrite(overlay, renewed);
      await vi.waitFor(() => expect(fs.readFileSync(source, 'utf8')).toBe(renewed), { timeout: 2_000, interval: 20 });
    } finally {
      stop();
    }
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

  it('Windows: gravação na origem recusada (EPERM, depois EBUSY) é tentada de novo sem nova mudança no overlay; o lock da CLI fica intacto', { retry: REAL_WATCH_EVENT_RETRIES }, async () => {
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

describe('fs.watch que morre sem erro: a rede de segurança lenta ainda devolve a renovação (M2)', () => {
  /** Limite superior da rede de segurança (contrato: um stat a cada 30–60 s). */
  const SAFETY_WINDOW_MS = 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Um fs.watch "vivo" que nunca entrega evento nem 'error': a pasta removida e
   * recriada no Linux (o evento chega com o nome da própria pasta e o filtro de
   * basename o descarta), FUSE/rede, overflow do FSEvents/inotify.
   */
  function silentWatch() {
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    watcher.close = vi.fn();
    vi.spyOn(fs, 'watch').mockReturnValue(watcher as unknown as fs.FSWatcher);
    return watcher;
  }

  function watchedPane(intervalMs = 600_000) {
    const native = tempDir();
    const dir = tempDir();
    const source = path.join(native, 'auth.json');
    const overlay = path.join(dir, 'auth.json');
    fs.writeFileSync(source, grokAuth('r1', '2026-09-23T01:59:00Z'));
    fs.copyFileSync(source, overlay);
    const stop = startAuthWriteThrough({ overlayFile: overlay, sourceFile: source, policy, intervalMs });
    return { source, overlay, stop };
  }

  it('sem nenhum evento do watch, a renovação do overlay volta à origem dentro do intervalo de segurança', () => {
    vi.useFakeTimers();
    silentWatch();
    const p = watchedPane();
    try {
      const renewed = grokAuth('r2', '2099-01-01T00:00:00Z');
      cliRenameWrite(p.overlay, renewed);
      expect(fs.readFileSync(p.source, 'utf8')).not.toBe(renewed);

      vi.advanceTimersByTime(SAFETY_WINDOW_MS);

      expect(fs.readFileSync(p.source, 'utf8')).toBe(renewed);
    } finally {
      p.stop();
    }
  });

  it('a passada acordada pela rede de segurança que a origem recusa (EBUSY) segue o retry do F-1485', () => {
    vi.useFakeTimers();
    silentWatch();
    const retryMs = 2_000;
    const p = watchedPane(retryMs);
    try {
      const refusals = ['EBUSY'];
      failSourceWrites(p.source, refusals);
      const renewed = grokAuth('r2', '2099-01-01T00:00:00Z');
      cliRenameWrite(p.overlay, renewed);

      // Anda até a 1ª passada de segurança, que a origem recusa (não importa
      // o valor exato da constante: só que ela cai dentro do contrato).
      for (let elapsed = 0; refusals.length > 0 && elapsed < SAFETY_WINDOW_MS; elapsed += 1_000) {
        vi.advanceTimersByTime(1_000);
      }
      expect(refusals).toEqual([]);
      expect(fs.readFileSync(p.source, 'utf8')).not.toBe(renewed);

      // Só o retry rápido (retryMs) pode recuperar agora; uma 2ª passada de
      // segurança está a dezenas de segundos.
      vi.advanceTimersByTime(retryMs);

      expect(fs.readFileSync(p.source, 'utf8')).toBe(renewed);
    } finally {
      p.stop();
    }
  });

  it('o disposer fecha o watcher e TODOS os temporizadores, o de segurança inclusive', () => {
    vi.useFakeTimers();
    const watcher = silentWatch();
    const p = watchedPane();

    expect(vi.getTimerCount()).toBe(1); // só a rede de segurança: nada de poll rápido ocioso
    p.stop();

    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // Depois do fechamento nada mais acorda: a mudança no overlay não volta sozinha.
    const late = grokAuth('r3', '2099-01-01T00:00:00Z');
    cliRenameWrite(p.overlay, late);
    vi.advanceTimersByTime(SAFETY_WINDOW_MS * 2);
    expect(fs.readFileSync(p.source, 'utf8')).not.toBe(late);
  });

  it('watch que acusa erro: o poll no ritmo do vigia assume e devolve a renovação; o disposer limpa tudo', () => {
    vi.useFakeTimers();
    const watcher = silentWatch();
    const pollMs = 20_000; // abaixo da rede de segurança: só o poll rápido explica a devolução
    const p = watchedPane(pollMs);
    try {
      watcher.emit('error', new Error('watch morreu (simulado)'));

      const renewed = grokAuth('r2', '2099-01-01T00:00:00Z');
      cliRenameWrite(p.overlay, renewed);
      vi.advanceTimersByTime(pollMs);

      expect(fs.readFileSync(p.source, 'utf8')).toBe(renewed);
    } finally {
      p.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
