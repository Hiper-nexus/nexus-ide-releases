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
  textNamesCli,
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

  it('reconhece a CLI digitada tecla a tecla no meio do turno (fila do agente)', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    // Cada keystroke vira um chunk próprio no tap (xterm onData por caractere).
    // O join antigo com espaço transformava "grok" em "g r o k" e o
    // operatorChoice era redistribuído (campo 05/10: "solta grok solta agy").
    for (const ch of 'solta grok solta agy') {
      type('sess-keystrokes', ch);
    }
    expect(operatorRecentlyNamedCli('sess-keystrokes', 'grok', now)).toBe(true);
    expect(operatorRecentlyNamedCli('sess-keystrokes', 'agy', now)).toBe(true);
    expect(operatorRecentlyNamedCli('sess-keystrokes', 'muse', now)).toBe(false);
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

describe('pedido tecla a tecla do operador (F-766)', () => {
  function typeKeys(sessionId: string, text: string) {
    for (const ch of text) type(sessionId, ch);
  }

  it('junta "cade grok" digitado letra a letra e aplica backspace no meio', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    typeKeys('pty-musg', 'cade grx');
    type('pty-musg', '\x7f');
    typeKeys('pty-musg', 'ok');
    expect(operatorRecentlyNamedCli('pty-musg', 'grok', now)).toBe(true);
    typeKeys('pty-bs', 'cade gro');
    type('pty-bs', '\b');
    typeKeys('pty-bs', 'ok');
    expect(operatorRecentlyNamedCli('pty-bs', 'grok', now)).toBe(true);
  });

  it('casa "anti gravity" com agy e "qwhen" com qwen; "glm" continua exato', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    typeKeys('anti', 'cade o anti gravity');
    typeKeys('typo', 'cade qwhen');
    type('curto', 'abre o gln');
    expect(operatorRecentlyNamedCli('anti', 'agy', now)).toBe(true);
    expect(operatorRecentlyNamedCli('typo', 'qwen', now)).toBe(true);
    expect(operatorRecentlyNamedCli('curto', 'glm', now)).toBe(false);
  });

  it('a frase inteira do compositor (um bloco humano) nomeia as CLIs; origem system não', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    const phrase = 'cade muse cade qwhen cade grok cade devin cade o anti gravity';
    type('composer', phrase);
    expect(operatorRecentlyNamedCli('composer', 'muse', now)).toBe(true);
    expect(operatorRecentlyNamedCli('composer', 'qwen', now)).toBe(true);
    expect(operatorRecentlyNamedCli('composer', 'grok', now)).toBe(true);
    expect(operatorRecentlyNamedCli('composer', 'devin', now)).toBe(true);
    expect(operatorRecentlyNamedCli('composer', 'agy', now)).toBe(true);
    type('sistema', phrase, 'system');
    expect(operatorRecentlyNamedCli('sistema', 'grok', now)).toBe(false);
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

/**
 * F-818: a distância de 1 edição do F-766 "provava" que o operador nomeou uma
 * CLI com palavras comuns — e o pin do Maestro deixava de ser redistribuído
 * (F-195/F-682). Agora só vale o nome (espaço/hífen flexível) ou uma grafia
 * errada EXPLÍCITA por alias.
 */
describe('palavras comuns não provam pedido de CLI (F-818)', () => {
  // Tabela da revisão ec8524a8 + vizinhas: cada uma casava por 1 edição.
  const COMMON_WORDS: Array<[string, string]> = [
    ['mude o botão de lugar', 'muse'],
    ['passa o mouse em cima do card', 'muse'],
    ['isso devia funcionar já', 'devin'],
    ['deixa a tela minimal', 'minimax-code'],
    ['cria um memo', 'mimo-code'],
    ['isso é um mito', 'mimo-code'],
    ['uma table nova', 'claude'],
    ['a clause do contrato', 'claude'],
    ['os cursos de inglês', 'cursor'],
    ['use o modo escuro', 'muse'],
    ['revise o code do parser', 'codex'],
    ['troca o codec de áudio', 'codex'],
    ['abre o painel de grade', 'grok'],
    ['o tema do site é minimo', 'minimax-code'],
  ];

  it.each(COMMON_WORDS)('"%s" não nomeia %s (texto puro)', (text, adapterId) => {
    expect(textNamesCli(text, adapterId)).toBe(false);
  });

  it('digitado no pane, nenhuma delas prova a CLI (operatorChoice continua preferência)', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    COMMON_WORDS.forEach(([text, adapterId], index) => {
      const sessionId = `comum-${index}`;
      type(sessionId, text);
      expect(operatorRecentlyNamedCli(sessionId, adapterId, now), `${adapterId}: ${text}`).toBe(false);
    });
  });

  it('digitado tecla a tecla, a palavra comum também não prova', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    for (const ch of 'passa o mouse em cima do card') type('comum-teclas', ch);
    expect(operatorRecentlyNamedCli('comum-teclas', 'muse', now)).toBe(false);
  });

  it('grafia errada FORA da tabela vira preferência, não prova (decisão do F-818)', () => {
    expect(textNamesCli('cade groc', 'grok')).toBe(false);
    expect(textNamesCli('cade codez', 'codex')).toBe(false);
    expect(textNamesCli('cade kimo', 'kimi')).toBe(false);
  });

  it('o nome real continua provando, com caixa, acento, espaço e hífen', () => {
    expect(textNamesCli('abre o muse pra mim', 'muse')).toBe(true);
    expect(textNamesCli('abre o Devin', 'devin')).toBe(true);
    expect(textNamesCli('usa o MiniMax', 'minimax-code')).toBe(true);
    expect(textNamesCli('usa o mini max', 'minimax-code')).toBe(true);
    expect(textNamesCli('usa o deep-seek', 'deepseek')).toBe(true);
    expect(textNamesCli('testa com qwen 3.8', 'qwen')).toBe(true);
    expect(textNamesCli('testa com qwen-3.8', 'qwen')).toBe(true);
    expect(textNamesCli('cade o anti gravity', 'agy')).toBe(true);
    expect(textNamesCli('cade o anti-gravity', 'agy')).toBe(true);
  });

  it('grafias erradas explícitas continuam provando (qwhen→qwen do F-766 e vizinhas)', () => {
    for (const [text, adapterId] of [
      ['cade qwhen', 'qwen'],
      ['cade quen', 'qwen'],
      ['abre o cluade', 'claude'],
      ['abre um codx', 'codex'],
      ['manda o gemni olhar', 'agy'],
      ['usa o deepsek', 'deepseek'],
      ['usa o kimmi', 'kimi'],
      ['chama o devim', 'devin'],
    ] as const) {
      expect(textNamesCli(text, adapterId), `${adapterId}: ${text}`).toBe(true);
    }
  });

  it('qwhen digitado tecla a tecla com backspace (caso real do F-766) continua provando', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    for (const ch of 'cade qwhex') type('qwhen-teclas', ch);
    type('qwhen-teclas', '\x7f');
    type('qwhen-teclas', 'n');
    expect(operatorRecentlyNamedCli('qwhen-teclas', 'qwen', now)).toBe(true);
  });
});

/**
 * F-1303 (ao vivo 12/10): o operador digitou "kimi nunca ta sendo usado…" no
 * pane do orquestrador e o spawn seguinte com `adapterId:'kimi',
 * operatorChoice:true` foi redistribuído — a menção tinha sumido do buffer.
 * Entre a menção e o spawn entrou uma colagem de ~10 KB (entrega de handoff)
 * como um ÚNICO write humano; o teto de 4.000 chars removia TODOS os chunks,
 * inclusive o próprio e as menções anteriores (inputBySession.delete).
 */
describe('F-1303: colagem gigante não apaga a menção do operador', () => {
  const PASTE_10K = `\x1b[200~${'entrega de handoff: tudo verde, sem bloqueio. '.repeat(230)}\x1b[201~`;

  it('menção recente sobrevive a uma colagem única maior que o teto da sessão', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - 2 * MIN);
    type('f1303-a', 'kimi nunca ta sendo usado');
    expect(PASTE_10K.length).toBeGreaterThan(4_000);
    type('f1303-a', PASTE_10K);
    expect(
      operatorRecentlyNamedCli('f1303-a', 'kimi', now, OPERATOR_CHOICE_PROOF_WINDOW_MS),
    ).toBe(true);
  });

  it('menção DENTRO da própria colagem gigante também conta (fica o final)', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('f1303-b', `\x1b[200~${'x'.repeat(9_000)} no fim o operador pede kimi code\x1b[201~`);
    expect(operatorRecentlyNamedCli('f1303-b', 'kimi', now)).toBe(true);
  });

  it('teto por sessão continua: depois de MUITOS chunks o mais antigo sai', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    type('f1303-c', 'abre um kimi');
    // > 4.000 chars em chunks pequenos (digitação corrida): evicção do lado
    // antigo continua valendo — só a forma do corte do chunk GRANDE mudou.
    for (let i = 0; i < 150; i++) type('f1303-c', `mensagem corrida numero ${i} do operador `);
    expect(operatorRecentlyNamedCli('f1303-c', 'kimi', now)).toBe(false);
  });

  it('hipótese 2 derrubada: mensagem que COMEÇA com a CLI após outra, sem Enter no tap', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now - MIN);
    // O compositor escreve a linha inteira (write humano único) e o Enter vem
    // depois, em chunk próprio. Se o Enter chegasse como CSI removido, o
    // replay ainda ganha fronteira: colagem nova após texto sem espaço em
    // branco recebe separador (replayInput).
    type('f1303-d', 'ejo na tabela acima minimax nao foi usado');
    type('f1303-d', 'kimi nunca ta sendo usado');
    expect(operatorRecentlyNamedCli('f1303-d', 'kimi', now)).toBe(true);
  });
});

/**
 * F-818: os padrões flexíveis (espaço/hífen entre letras) rodam sobre texto do
 * operador; a varredura tem de ser linear. O buffer do pane retém ≤ 4.000
 * caracteres, mas a função pura recebe qualquer tamanho — mede-se 16 KB.
 */
describe('F-818: varredura linear em texto do operador', () => {
  const SIZE = 16_384;
  const ADAPTERS = [
    'claude', 'codex', 'grok', 'agy', 'kimi', 'glm', 'glm-flash', 'mimo-code',
    'minimax-code', 'devin', 'longcat', 'muse', 'deepseek', 'opencode',
    'openclaude', 'aider', 'qwen', 'cursor',
  ];
  const inputs: Array<[string, string]> = [
    ['espaços sem fim', ' '.repeat(SIZE)],
    ['hífens sem fim', '-'.repeat(SIZE)],
    ['"m" seguido de espaços', `m${' '.repeat(SIZE - 1)}`],
    ['"qwe" seguido de espaços', `qwe${' '.repeat(SIZE - 3)}`],
    ['"anti" seguido de hífens', `anti${'-'.repeat(SIZE - 4)}`],
    ['letras do alias separadas', 'c l a u d '.repeat(SIZE / 10)],
    ['prefixos repetidos de qwen', 'q w e '.repeat(SIZE / 6)],
    ['prefixo de typo repetido', 'qwh '.repeat(SIZE / 4)],
    ['"m u s" repetido', 'm u s '.repeat(SIZE / 6)],
    ['"deep" e "seek" soltos', 'deep seek '.slice(0, 9).repeat(SIZE / 9)],
    ['tabs e espaços', '\t \t '.repeat(SIZE / 4)],
  ];

  it.each(inputs)('%s: todas as CLIs, em tempo linear', (_label, text) => {
    const run = () => ADAPTERS.map((id) => textNamesCli(text, id));
    run(); // aquece: compilação/tier-up da regex não é o que se mede
    const startedAt = performance.now();
    run();
    const elapsedMs = performance.now() - startedAt;
    // 18 CLIs × todos os aliases e grafias erradas: linear fica em poucos ms.
    expect(elapsedMs).toBeLessThan(50);
  });
});
