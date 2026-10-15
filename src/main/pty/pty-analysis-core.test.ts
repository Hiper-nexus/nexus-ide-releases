import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileManifest } from '../detect/compiler';
import { loadManifestDir } from '../detect/manifest';
import { PtyAnalysisCore } from './pty-analysis-core';
import type { AnalysisInput, AnalysisResult, AnalysisWorkerTrace } from './pty-analysis-protocol';

describe('detector grid winsize (DSK-03)', () => {
  const codex = loadManifestDir(path.join(process.cwd(), 'resources/agent-detection'))
    .filter(({ manifest }) => manifest.id === 'codex').map(({ manifest }) => compileManifest(manifest));
  // An old question five rows above the live footer: visible on 24 rows, gone on 3.
  const output = 'Would you like to continue? yes\r\n' + [1, 2, 3, 4, 5].map((n) => `out ${n}\r\n`).join('') + '• Working (1s • esc to interrupt)';
  function screenStates(resize?: { cols: number; rows: number }, ghosttyWasmPath?: string) {
    const results: AnalysisResult[] = [];
    const traces: AnalysisWorkerTrace[] = [];
    const core = new PtyAnalysisCore(codex, (result) => results.push(result), undefined, { ghosttyWasmPath, trace: (event) => traces.push(event) });
    let seq = 0;
    const feed = (body: object) => core.process({ workerEpoch: 1, generation: 1, sessionId: 's', eventSeq: ++seq, observedAt: 100 + seq, ...body } as AnalysisInput);
    feed({ kind: 'bind', binding: { adapterId: 'codex', paneId: 'p' } });
    feed({ kind: 'arm', consumer: 'screen', registration: 1 });
    if (resize) feed({ kind: 'resize', ...resize });
    feed({ kind: 'data', data: output });
    feed({ kind: 'flush' });
    core.close();
    const states = results.flatMap((r) => r.events).filter((e) => e.consumer === 'screen')
      .map((e) => (e.value as { record?: { state: string } }).record?.state).filter(Boolean);
    return { states, traces };
  }
  it('applies the PTY winsize before the bytes that follow it', () => {
    expect(screenStates().states.at(-1)).toBe('blocked');
    expect(screenStates({ cols: 80, rows: 3 })).toEqual({ states: ['working'], traces: [] });
  });
  it('ignores an out-of-range winsize', () => {
    expect(screenStates({ cols: 0, rows: 3 }).states.at(-1)).toBe('blocked');
    expect(screenStates({ cols: 80, rows: 100_000 }).states.at(-1)).toBe('blocked');
  });
  it('falls back to the text stream when the grid cannot load, and says so', () => {
    const { states, traces } = screenStates({ cols: 80, rows: 3 }, path.join(process.cwd(), 'resources/ghostty/absent-for-test.wasm'));
    expect(traces).toEqual([{ kind: 'detector-ghostty-unavailable', reason: 'unavailable', detail: 'ENOENT' }]);
    // Text stream: the stale question is still in the tail.
    expect(states.at(-1)).toBe('blocked');
  });
});

function fixture() {
  const results: AnalysisResult[] = [];
  const core = new PtyAnalysisCore([], (result) => results.push(result));
  let seq = 0;
  const feed = (body: object) => core.process({ workerEpoch: 1, generation: 1, sessionId: 's', eventSeq: ++seq, observedAt: 100 + seq, ...body } as AnalysisInput);
  feed({ kind: 'bind', binding: { adapterId: 'codex' } });
  return { core, feed, results };
}

describe('production analysis reducers', () => {
  it('preserves split ANSI/OSC and local dev URLs', () => {
    const raw = '\x1b[32mLocal: http://localhost:5173/\x1b[0m\n\x1b]133;E;echo hello\x07\x1b]133;B\x07\x1b]133;D;0\x07';
    for (let split = 0; split <= raw.length; split++) {
      const { core, feed, results } = fixture();
      feed({ kind: 'arm', consumer: 'dev-server', registration: 1 });
      feed({ kind: 'arm', consumer: 'command', registration: 1 });
      feed({ kind: 'data', data: raw.slice(0, split) });
      feed({ kind: 'data', data: raw.slice(split) });
      feed({ kind: 'flush' });
      const events = results.flatMap((r) => r.events);
      expect(events.filter((e) => e.consumer === 'dev-server').map((e) => e.value)).toContainEqual(['http://localhost:5173/']);
      expect(events.filter((e) => e.consumer === 'command').flatMap((e) => e.value)).toContainEqual({ kind: 'command_finished', exitCode: 0 });
      expect(results.map((r) => r.screenAppend ?? '').join('')).toBe('Local: http://localhost:5173/\n');
      expect(results.some((r) => r.screenText !== undefined)).toBe(false);
      core.close();
    }
  });
  it('scans quota markers in the middle of a megabyte instead of only its tail', () => {
    const { core, feed, results } = fixture();
    feed({ kind: 'arm', consumer: 'failover', registration: 1 });
    feed({ kind: 'data', data: 'x'.repeat(500_000) + '\nusage limit reached\n' + 'y'.repeat(500_000) });
    expect(results.flatMap((r) => r.events).some((e) => e.consumer === 'failover' && (e.value as { hit?: { kind: string } }).hit?.kind === 'rate-limit')).toBe(true);
    core.close();
  });
  it('F-999: pack de continuidade colado na sessão segura o 1º sinal de modelo da saída', () => {
    const { core, feed, results } = fixture();
    feed({ kind: 'arm', consumer: 'failover', registration: 1 });
    // O renderer cola o pack (bracketed paste); a TUI mostra só o resumo da colagem.
    feed({ kind: 'input', data: '\x1b[200~[NEXUS FAILOVER HANDOFF]\nAccount "x" hit a provider limit (kind model).\nExecute the next concrete step now.\x1b[201~' });
    feed({ kind: 'data', data: '> [Pasted text #1 +3 lines]\nRetomando: a sessão anterior caiu com model_not_found, sigo daqui.\n' });
    feed({ kind: 'flush' });
    const failover = results.flatMap((r) => r.events).filter((e) => e.consumer === 'failover').map((e) => e.value as { hit?: unknown; held?: { kind: string } });
    expect(failover.some((value) => value.hit)).toBe(false);
    expect(failover.some((value) => value.held?.kind === 'model')).toBe(true);
    core.close();
  });
  it('seals PRONTO immediately before exit and excludes registered prompt echo', () => {
    const { core, feed, results } = fixture();
    feed({ kind: 'arm', consumer: 'completion', registration: 1, config: { prompt: 'Escreva PRONTO: <resumo>' } });
    feed({ kind: 'data', data: 'PRONTO: <resumo>\n' });
    expect(results.flatMap((r) => r.events)).toHaveLength(0);
    feed({ kind: 'data', data: 'PRONTO: código entregue' });
    feed({ kind: 'exit' });
    expect(results.at(-1)?.events).toContainEqual({ consumer: 'completion', registration: 1, value: { kind: 'done', text: 'código entregue', at: 105 }, archival: true });
    core.close();
  });
});

describe('F-1419: o primeiro working do detector fecha o responder de primeira execução', () => {
  const codex = loadManifestDir(path.join(process.cwd(), 'resources/agent-detection'))
    .filter(({ manifest }) => manifest.id === 'codex').map(({ manifest }) => compileManifest(manifest));
  const CWD = '/Users/op/Library/Application Support/NexusIDE/worktrees.noindex/task-3b7d';
  const TRUST = `✓ Trust ${CWD}?  ❭ 1 Yes, trust / 2 No, exit  ↓↑ to select · ↵ to choose`;
  function firstRunAnswers(workingFirst: boolean) {
    const results: AnalysisResult[] = [];
    const core = new PtyAnalysisCore(codex, (result) => results.push(result));
    let seq = 0;
    const feed = (body: object) => core.process({ workerEpoch: 1, generation: 1, sessionId: 's', eventSeq: ++seq, observedAt: 100 + seq, ...body } as AnalysisInput);
    feed({ kind: 'bind', binding: { adapterId: 'codex', paneId: 'p' } });
    feed({ kind: 'arm', consumer: 'screen', registration: 1 });
    feed({ kind: 'arm', consumer: 'first-run', registration: 1 });
    feed({ kind: 'control', consumer: 'first-run', value: { bind: { adapterId: 'devin', missionId: 'm-1', cwd: CWD } } });
    if (workingFirst) {
      feed({ kind: 'resize', cols: 80, rows: 3 });
      feed({ kind: 'data', data: '• Working (1s • esc to interrupt)' });
      feed({ kind: 'flush' });
      expect(results.flatMap((r) => r.events).filter((e) => e.consumer === 'screen')
        .map((e) => (e.value as { record?: { state: string } }).record?.state)).toContain('working');
    }
    feed({ kind: 'data', data: `\r\n${TRUST}\r\n` });
    core.close();
    return results.flatMap((r) => r.events).filter((e) => e.consumer === 'first-run').map((e) => e.value);
  }

  it('sem trabalho real ainda, a pergunta de trust do cwd do pane é respondida', () => {
    expect(firstRunAnswers(false)).toEqual([{ answer: '1\r', pattern: 'devin-trust-path' }]);
  });

  it('depois do primeiro working, a mesma pergunta não recebe tecla', () => {
    expect(firstRunAnswers(true)).toEqual([]);
  });
});
