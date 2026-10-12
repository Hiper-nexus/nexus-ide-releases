import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pty = vi.hoisted(() => ({
  inputTaps: new Set<(sessionId: string, data: string, origin: string) => void>(),
  exitTaps: new Set<(sessionId: string) => void>(),
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionInput: (cb: (s: string, d: string, o: string) => void) => {
    pty.inputTaps.add(cb);
    return () => pty.inputTaps.delete(cb);
  },
  tapSessionExit: (cb: (s: string) => void) => {
    pty.exitTaps.add(cb);
    return () => pty.exitTaps.delete(cb);
  },
  getAgentSessionInfo: () => null,
}));
vi.mock('../persistence/provider-session-store', () => ({
  getProviderPaneSession: () => null,
}));

import {
  installOperatorCliMentionTap,
  OPERATOR_CHOICE_PROOF_WINDOW_MS,
  operatorRecentlyNamedCli,
} from './operator-cli-mentions';
import {
  extractClaudeHumanPrompts,
  operatorNamedCliInSubmittedPrompts,
} from './operator-submitted-prompts';

const PHRASE = 'solta mais panes usa devin e muse tbm';
// Carimbos do campo (12/10, mission-94d90f5b): Enter em 21:12:27.7, spawn
// do Devin em 21:18:03.
const SUBMITTED_ISO = '2026-10-12T21:12:27.721Z';
const SUBMITTED_AT = Date.parse(SUBMITTED_ISO);
const SPAWN_AT = Date.parse('2026-10-12T21:18:03.155Z');

/** Linhas no formato do transcript do Claude Code 2.1.296 (campo 12/10). */
const TRANSCRIPT = [
  JSON.stringify({
    type: 'queue-operation', operation: 'enqueue',
    timestamp: '2026-10-12T21:12:27.808Z', content: PHRASE,
  }),
  JSON.stringify({
    type: 'attachment',
    attachment: {
      type: 'queued_command', prompt: PHRASE, commandMode: 'prompt',
      origin: { kind: 'human' }, timestamp: SUBMITTED_ISO,
      inputSource: 'suggestion_accepted', humanTurn: true,
    },
    timestamp: SUBMITTED_ISO,
  }),
  JSON.stringify({
    type: 'user', origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>usa o grok</task-notification>' },
    timestamp: '2026-10-12T21:13:00.000Z',
  }),
  JSON.stringify({
    type: 'user', isMeta: true, origin: { kind: 'human' },
    message: { role: 'user', content: 'meta cita o qwen' },
    timestamp: '2026-10-12T21:13:01.000Z',
  }),
  '{"type":"user","origin":{"kind":"human"}, quebrado',
].join('\n');

let disposer: (() => void) | null = null;

function type(sessionId: string, data: string, origin = 'human') {
  pty.inputTaps.forEach((cb) => cb(sessionId, data, origin));
}

beforeEach(() => {
  pty.inputTaps.clear();
  pty.exitTaps.clear();
  disposer = installOperatorCliMentionTap();
});

afterEach(() => {
  disposer?.();
  disposer = null;
  vi.restoreAllMocks();
});

describe('extractClaudeHumanPrompts (F-1418)', () => {
  it('pega a mensagem do meio do turno (queued_command humano) e ignora notificação, meta e lixo', () => {
    expect(extractClaudeHumanPrompts(TRANSCRIPT)).toEqual([
      { at: SUBMITTED_AT, text: PHRASE },
    ]);
  });

  it('mensagem de usuário comum com origem humana também conta; filtra pela janela', () => {
    const line = JSON.stringify({
      type: 'user', origin: { kind: 'human' },
      message: { role: 'user', content: [{ type: 'text', text: 'usa o kimi' }] },
      timestamp: '2026-10-12T21:20:00.000Z',
    });
    expect(extractClaudeHumanPrompts(line)).toEqual([
      { at: Date.parse('2026-10-12T21:20:00.000Z'), text: 'usa o kimi' },
    ]);
    expect(extractClaudeHumanPrompts(line, Date.parse('2026-10-12T21:21:00.000Z'))).toEqual([]);
  });
});

describe('operatorNamedCliInSubmittedPrompts — campo 12/10 (F-1418)', () => {
  const deps = {
    transcriptFor: (sessionId: string) => (sessionId === 'pty-orch' ? '/t/orch.jsonl' : null),
    readTail: async () => TRANSCRIPT,
  };

  it('"solta mais panes usa devin e muse tbm" aceito como sugestão prova devin E muse', async () => {
    // O PTY recebeu só o Enter do operador, ~100 ms antes do carimbo.
    vi.spyOn(Date, 'now').mockReturnValue(SUBMITTED_AT - 90);
    type('pty-orch', '\r');
    // Sem o transcript, o tap não sabia de nada: era o redistribuído.
    expect(operatorRecentlyNamedCli('pty-orch', 'devin', SPAWN_AT, OPERATOR_CHOICE_PROOF_WINDOW_MS)).toBe(false);
    for (const adapterId of ['devin', 'muse']) {
      await expect(operatorNamedCliInSubmittedPrompts(
        'pty-orch', adapterId, SPAWN_AT, OPERATOR_CHOICE_PROOF_WINDOW_MS, deps,
      )).resolves.toBe(true);
    }
    await expect(operatorNamedCliInSubmittedPrompts(
      'pty-orch', 'kimi', SPAWN_AT, OPERATOR_CHOICE_PROOF_WINDOW_MS, deps,
    )).resolves.toBe(false);
  });

  it('sem Enter humano (texto injetado pelo Nexus), sem transcript ou com erro de leitura: falha fechada', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SUBMITTED_AT - 90);
    type('pty-orch', '\r', 'system');
    await expect(operatorNamedCliInSubmittedPrompts(
      'pty-orch', 'devin', SPAWN_AT, OPERATOR_CHOICE_PROOF_WINDOW_MS, deps,
    )).resolves.toBe(false);
    type('pty-outro', '\r');
    await expect(operatorNamedCliInSubmittedPrompts(
      'pty-outro', 'devin', SPAWN_AT, OPERATOR_CHOICE_PROOF_WINDOW_MS, deps,
    )).resolves.toBe(false);
    type('pty-orch', '\r');
    await expect(operatorNamedCliInSubmittedPrompts(
      'pty-orch', 'devin', SPAWN_AT, OPERATOR_CHOICE_PROOF_WINDOW_MS,
      { ...deps, readTail: async () => { throw new Error('EACCES'); } },
    )).resolves.toBe(false);
    // Produção sem sessão Claude conhecida (getAgentSessionInfo → null).
    await expect(operatorNamedCliInSubmittedPrompts(
      'pty-orch', 'devin', SPAWN_AT, OPERATOR_CHOICE_PROOF_WINDOW_MS,
    )).resolves.toBe(false);
  });
});
