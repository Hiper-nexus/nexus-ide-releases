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
}));

import {
  installOperatorCliMentionTap,
  noteOperatorDirection,
  OPERATOR_CHOICE_PROOF_WINDOW_MS,
  operatorRecentlyNamedCli,
} from './operator-cli-mentions';

const MIN = 60_000;
let disposer: (() => void) | null = null;

function type(sessionId: string, data: string, origin = 'human') {
  pty.inputTaps.forEach((cb) => cb(sessionId, data, origin));
}

function exit(sessionId: string) {
  pty.exitTaps.forEach((cb) => cb(sessionId));
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

describe('operatorRecentlyNamedCli', () => {
  it('reconhece a CLI que o operador digitou nesta sessão', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - 2 * MIN);
    type('sess-a', 'abre um codex para revisar o diff');
    expect(operatorRecentlyNamedCli('sess-a', 'codex', now)).toBe(true);
    expect(operatorRecentlyNamedCli('sess-a', 'claude', now)).toBe(false);
  });

  it('casa aliases por família de adapter', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('s1', 'pede pro opus fazer o parser');
    type('s2', 'manda o gemini olhar os logs');
    type('s3', 'roda no swe essa tarefa');
    type('s4', 'usa o zai pra isso');
    type('s5', 'chama o xiaomi');
    type('s6', 'testa com o moonshot');
    type('s7', 'openai pra variar');
    type('s8', 'passa pro qwen revisar');
    type('s9', 'qwen code nesse diff');
    type('s10', 'testa com qwen 3.8');
    expect(operatorRecentlyNamedCli('s1', 'claude', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s2', 'agy', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s3', 'devin', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s4', 'glm', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s4', 'glm-flash', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s5', 'mimo-code', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s6', 'kimi', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s7', 'codex', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s8', 'qwen', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s9', 'qwen', now)).toBe(true);
    expect(operatorRecentlyNamedCli('s10', 'qwen', now)).toBe(true);
  });

  it('só casa palavra inteira — sol e terra nunca são codex', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('s1', 'o sol nasceu em terra firme, codificar');
    expect(operatorRecentlyNamedCli('s1', 'codex', now)).toBe(false);
    type('s2', 'use o grokky fork');
    expect(operatorRecentlyNamedCli('s2', 'grok', now)).toBe(false);
    type('s3', 'antigravity boots');
    expect(operatorRecentlyNamedCli('s3', 'agy', now)).toBe(true);
  });

  it('normaliza caixa e acentos', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('s1', 'Abre um CÓDEX aí');
    expect(operatorRecentlyNamedCli('s1', 'codex', now)).toBe(true);
  });

  it('ignora sequências ANSI, CSI, OSC e marcadores de paste', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('s1', '\x1b[200~abre um \x1b[1;32mcodex\x1b[0m agora\x1b[201~');
    expect(operatorRecentlyNamedCli('s1', 'codex', now)).toBe(true);
    type('s2', 'o \x1b]8;;http://x\x07cod\x1b\\ex não conta');
    expect(operatorRecentlyNamedCli('s2', 'codex', now)).toBe(true);
  });

  it('só olha os últimos 15 minutos', () => {
    const now = 10_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - 16 * MIN);
    type('s1', 'abre um codex');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(operatorRecentlyNamedCli('s1', 'codex')).toBe(false);
    type('s1', 'agora um claude');
    expect(operatorRecentlyNamedCli('s1', 'claude')).toBe(true);
    expect(operatorRecentlyNamedCli('s1', 'codex')).toBe(false);
  });

  it('limpa a memória da sessão ao sair', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('s1', 'abre um codex');
    exit('s1');
    expect(operatorRecentlyNamedCli('s1', 'codex', now)).toBe(false);
  });

  it('ignora input de origem system (só humano conta)', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('s1', 'abre um codex', 'system');
    expect(operatorRecentlyNamedCli('s1', 'codex', now)).toBe(false);
  });

  it('adapter desconhecido casa pelo próprio id', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('s1', 'abre o meucli-custom');
    expect(operatorRecentlyNamedCli('s1', 'meucli-custom', now)).toBe(true);
  });

  it('sessão sem input recente devolve false', () => {
    expect(operatorRecentlyNamedCli('nunca-digitou', 'claude')).toBe(false);
    expect(operatorRecentlyNamedCli(undefined, 'claude')).toBe(false);
  });
});

describe('prova do operatorChoice (F-682)', () => {
  it('orientação do Quadro aceita conta como pedido do operador naquela sessão', () => {
    noteOperatorDirection('maestro', 'abre um helper no MiniMax para a revisão');
    expect(operatorRecentlyNamedCli('maestro', 'minimax-code')).toBe(true);
    expect(operatorRecentlyNamedCli('maestro', 'claude')).toBe(false);
  });

  it('a janela da prova do operatorChoice cobre a retenção inteira (30 min), a comum só 15', () => {
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    type('maestro-janela', 'usa o claude nisso');
    const later = t0 + 20 * MIN;
    expect(operatorRecentlyNamedCli('maestro-janela', 'claude', later)).toBe(false);
    expect(operatorRecentlyNamedCli('maestro-janela', 'claude', later, OPERATOR_CHOICE_PROOF_WINDOW_MS)).toBe(true);
    expect(operatorRecentlyNamedCli('maestro-janela', 'claude', t0 + 31 * MIN, OPERATOR_CHOICE_PROOF_WINDOW_MS)).toBe(false);
  });
});
