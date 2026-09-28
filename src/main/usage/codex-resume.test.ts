import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageEvent } from './claude-transcript';
import { CodexUsageScanner } from './codex-scanner';
import { MIN_RESUMABLE_PREFIX_BYTES } from './codex-rollout-resume-state';
import type { CodexRolloutSource } from './codex-scanner';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function dayDirectory(root: string): string {
  const date = new Date();
  const directory = path.join(
    root,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function usageLine(timestamp: string, input: number, output: number): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } },
    },
  });
}

/** Rollout acima do piso de resume: meta + 2 usos + padding irrelevante. */
function writeRollout(file: string, usages: Array<[string, number, number]>): void {
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'session-r', cwd: '/workspace' },
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
    ...usages.map(([ts, i, o]) => usageLine(ts, i, o)),
  ];
  // Padding com linhas JSON irrelevantes (parseCodexLine ignora) até o piso.
  let body = `${lines.join('\n')}\n`;
  const padLine = `${JSON.stringify({ type: 'noop', payload: {} })}\n`;
  while (Buffer.byteLength(body) <= MIN_RESUMABLE_PREFIX_BYTES + 1000) {
    body += padLine;
  }
  fs.writeFileSync(file, body);
}

function totals(events: UsageEvent[]): { input: number; output: number } {
  return {
    input: events.reduce((sum, event) => sum + event.inputTokens, 0),
    output: events.reduce((sum, event) => sum + event.outputTokens, 0),
  };
}

async function scanOnce(
  sessionsDir: string,
  persistDir: string,
  seen: UsageEvent[],
  expectCount: number,
  isWatched: (cwd: string) => boolean = () => true,
  ready?: () => boolean,
): Promise<void> {
  const scanner = new CodexUsageScanner({
    sessionsDir,
    persistDir,
    pollMs: 60_000,
    isWatched,
    onEvent: (event: UsageEvent, _cwd: string, _source: CodexRolloutSource) => {
      seen.push(event);
    },
  });
  scanner.start();
  const deadline = Date.now() + 5_000;
  try {
    // Espera até a contagem esperada; para zero, aguenta 1.5s para provar
    // que nada mais chega (o scan imediato do start roda em ms).
    const settleUntil =
      expectCount === 0 ? Date.now() + 1_500 : deadline;
    while (Date.now() < deadline) {
      // Scan fatiado (8 ms + setTimeout) pode passar de 1,5 s numa máquina
      // carregada: quem precisa do store gravado espera por ele, não pelo relógio.
      if (ready && seen.length >= expectCount && ready()) return;
      if (!ready && seen.length >= expectCount && Date.now() >= settleUntil) return;
      if (seen.length >= expectCount && expectCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    scanner.stop();
  }
}

describe('CodexUsageScanner verified resume', () => {
  it('reemite zero eventos no restart e conta só o append, com totais idênticos', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    roots.push(sessionsDir, persistDir);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    writeRollout(rollout, [
      ['2026-07-10T10:00:00.000Z', 20, 3],
      ['2026-07-10T10:01:00.000Z', 30, 5],
    ]);

    const first: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, first, 2);
    expect(first).toHaveLength(2);
    expect(totals(first)).toEqual({ input: 50, output: 8 });
    const baselineIds = first.map((event) => event.messageId);
    expect(new Set(baselineIds).size).toBe(2);
    expect(
      fs.existsSync(path.join(persistDir, 'codex-resume.json')),
    ).toBe(true);

    // Restart sem append: resume verificado pula o prefixo, zero reemissão.
    const second: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, second, 0);
    expect(second).toHaveLength(0);

    // Append de um uso: restart conta exatamente 1, com id ordinal novo.
    fs.appendFileSync(
      rollout,
      `${usageLine('2026-07-10T10:02:00.000Z', 40, 7)}\n`,
    );
    const third: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, third, 1);
    expect(third).toHaveLength(1);
    expect(third[0].inputTokens).toBe(40);
    expect(third[0].outputTokens).toBe(7);
    expect(baselineIds).not.toContain(third[0].messageId);
    expect(totals([...first, ...third])).toEqual({ input: 90, output: 15 });
  }, 20_000);

  it('recupera com reparse integral quando o head muda sob o mesmo tamanho', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    roots.push(sessionsDir, persistDir);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    writeRollout(rollout, [['2026-07-10T10:00:00.000Z', 20, 3]]);

    const first: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, first, 1);
    expect(first).toHaveLength(1);

    // Reescreve o head (mesmo tamanho, session diferente): digest reprova.
    const bytes = fs.readFileSync(rollout);
    const rewritten = Buffer.from(
      bytes.toString('utf8').replace('session-r', 'session-x'),
    );
    expect(rewritten.length).toBe(bytes.length);
    fs.writeFileSync(rollout, rewritten);

    const second: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, second, 1);
    // Reparse integral recupera (reemite; o store dedupa por id estável).
    expect(second).toHaveLength(1);
    expect(second[0].sessionId).toBe('session-x');
  }, 20_000);

  it('ignora store corrompido e recomeça sem lançar', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    roots.push(sessionsDir, persistDir);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    writeRollout(rollout, [['2026-07-10T10:00:00.000Z', 20, 3]]);
    fs.writeFileSync(path.join(persistDir, 'codex-resume.json'), '{corrompido');

    const seen: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, seen, 1);
    expect(seen).toHaveLength(1);
  }, 20_000);

  // Achados do code review sênior (agy): regressões pinadas.

  it('não repete o replay inactive a cada boot: o registro some ao ativar', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    roots.push(sessionsDir, persistDir);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    // Pequeno de propósito (< piso): nunca ganha registro com digest.
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'session-i', cwd: '/elsewhere' },
        }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5' } }),
        usageLine('2026-07-10T10:00:00.000Z', 20, 3),
        '',
      ].join('\n'),
    );
    const storeFile = path.join(persistDir, 'codex-resume.json');

    // Boot 1: projeto inativo estaciona e persiste o park.
    await scanOnce(sessionsDir, persistDir, [], 0, () => false);
    const parked = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as {
      files: Record<string, { inactiveCwd: string | null }>;
    };
    expect(parked.files[rollout]?.inactiveCwd).toBe('/elsewhere');

    // Boot 2: projeto ativo faz replay e APAGA o registro inactive.
    const replayed: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, replayed, 1, () => true);
    expect(replayed).toHaveLength(1);
    const after = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as {
      files: Record<string, unknown>;
    };
    expect(after.files[rollout]).toBeUndefined();
  }, 20_000);

  it('rotação sob park inactive não estaciona o conteúdo novo para sempre', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    roots.push(sessionsDir, persistDir);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'session-old', cwd: '/elsewhere' },
        }),
        `${JSON.stringify({ type: 'noop', payload: {} })}\n`.repeat(50),
        '',
      ].join('\n'),
    );
    await scanOnce(sessionsDir, persistDir, [], 0, () => false);

    // Rotação: arquivo menor, cwd agora observado.
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { session_id: 'session-new', cwd: '/workspace' },
        }),
        usageLine('2026-07-10T10:00:00.000Z', 20, 3),
        '',
      ].join('\n'),
    );
    const seen: UsageEvent[] = [];
    await scanOnce(
      sessionsDir,
      persistDir,
      seen,
      1,
      (cwd) => cwd === '/workspace',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe('session-new');
  }, 20_000);

  it('head trocado sob skip invalida o skip em vez de sumir com o arquivo', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    roots.push(sessionsDir, persistDir);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    // >128KB sem meta: skip persistido com digest de head.
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({ type: 'noop', payload: {} })}\n`.repeat(6000),
    );
    const storeFile = path.join(persistDir, 'codex-resume.json');
    await scanOnce(sessionsDir, persistDir, [], 0, undefined, () => fs.existsSync(storeFile));
    const skipped = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as {
      files: Record<string, { skip: boolean; headDigest: string | null }>;
    };
    expect(skipped.files[rollout]?.skip).toBe(true);
    expect(typeof skipped.files[rollout]?.headDigest).toBe('string');

    // Mesmo tamanho, head agora com meta: o digest reprova e o arquivo volta.
    const replacement = [
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'session-s', cwd: '/workspace' },
      }),
      usageLine('2026-07-10T10:00:00.000Z', 20, 3),
    ].join('\n');
    const pad = '\n' + ' '.repeat(Math.max(0, fs.statSync(rollout).size - replacement.length - 1)) + '\n';
    fs.writeFileSync(rollout, replacement + pad);
    const seen: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, seen, 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe('session-s');
  }, 20_000);

  it('registro incompleto é purgado em vez de assombrar o store', async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
    roots.push(sessionsDir, persistDir);
    const rollout = path.join(dayDirectory(sessionsDir), 'rollout-test.jsonl');
    writeRollout(rollout, [['2026-07-10T10:00:00.000Z', 20, 3]]);
    fs.writeFileSync(
      path.join(persistDir, 'codex-resume.json'),
      JSON.stringify({
        version: 1,
        files: {
          [rollout]: {
            offset: 999999,
            size: 999999,
            ingest: null,
            skip: false,
            inactiveCwd: null,
            headDigest: null,
            boundaryDigest: null,
          },
        },
      }),
    );
    const seen: UsageEvent[] = [];
    await scanOnce(sessionsDir, persistDir, seen, 1);
    expect(seen).toHaveLength(1);
    const after = JSON.parse(
      fs.readFileSync(path.join(persistDir, 'codex-resume.json'), 'utf8'),
    ) as { files: Record<string, { offset: number }> };
    // Registro fantasma sumiu; o que resta (se houver) é offset real.
    expect(after.files[rollout]?.offset).not.toBe(999999);
  }, 20_000);
});
