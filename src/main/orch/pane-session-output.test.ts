import { describe, expect, it, vi } from "vitest";
import { Worker } from 'node:worker_threads';

const stubs = vi.hoisted(() => ({
  getSessionState: vi.fn((): "busy" | "idle" | null => "busy"),
  isOneShotSessionRunning: vi.fn((_sessionId: string) => false),
  analysisEnabled: vi.fn(() => false),
  analysisText: vi.fn(() => ""),
  analysisStatus: vi.fn((_sessionId: string): string | null => 'active'),
}));

vi.mock("../pty/pty-manager", () => ({
  getSessionState: stubs.getSessionState,
  isOneShotSessionRunning: (sessionId: string) =>
    stubs.isOneShotSessionRunning(sessionId),
}));

vi.mock('../pty/pty-analysis-runtime', () => ({
  isPtyAnalysisEnabled: stubs.analysisEnabled,
  analysisClient: { text: stubs.analysisText, status: stubs.analysisStatus },
}));

import {
  readSessionOutput,
  recordPaneSessionData,
  __evictExitedBufferForTests,
  __resetDeliberatelyClosedPanesForTests,
  markPaneDeliberatelyClosed,
  newOutputSince,
  paneSessionStateForEntry,
  recordPaneSessionExit,
  recordPaneSessionState,
  waitForIdle,
  waitForNextIdle,
  wasPaneDeliberatelyClosed,
  wasPaneSessionExitObserved,
} from "./pane-session-output";

describe("pane session idle wait cancellation", () => {
  it("rejects immediately with the exact abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("orchestration coordinator stopped");
    const pending = waitForIdle(
      "session-aborted-during-boot",
      60_000,
      controller.signal,
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});


// Campo (14/08): o ring de sessão morta sai após 5min e o state do pane caía
// de volta pro último entry.state ('idle') — pane morto ressuscitava como
// vivo no snapshot e o watcher da Via Rápida nunca via livePanes===0.
describe("marca de exit persiste além do TTL do buffer", () => {
  it("pane morto continua 'exited' depois da evicção do ring", () => {
    // duas consultas: antes e depois da evicção do ring
    stubs.getSessionState.mockReturnValueOnce(null as unknown as "busy");
    stubs.getSessionState.mockReturnValueOnce(null as unknown as "busy");
    recordPaneSessionState("pane-morto", "idle");
    recordPaneSessionExit("pane-morto");
    const entry = {
      paneId: "pane-morto",
      title: "pane morto",
      kind: "cli-agent",
      sessionId: "pane-morto",
      state: "idle" as const,
    } satisfies Parameters<typeof paneSessionStateForEntry>[0];
    expect(paneSessionStateForEntry(entry)).toBe("exited");
    __evictExitedBufferForTests("pane-morto");
    expect(paneSessionStateForEntry(entry)).toBe("exited");
  });

  it("F-1312: paneSessionStateForEntry devolve busy para processo one-shot vivo", () => {
    stubs.isOneShotSessionRunning.mockImplementation((s) => s === "session-oneshot");
    stubs.getSessionState.mockReturnValue("idle");
    const entry = {
      paneId: "pane-oneshot",
      title: "one-shot running",
      kind: "cli-agent",
      sessionId: "session-oneshot",
      state: "idle" as const,
    } satisfies Parameters<typeof paneSessionStateForEntry>[0];
    expect(paneSessionStateForEntry(entry)).toBe("busy");
  });
});

describe('waitForNextIdle — pane_ask não colhe a tela antiga', () => {
  it('pane já idle só resolve depois de busy→idle', async () => {
    stubs.getSessionState.mockReturnValue('idle');
    recordPaneSessionState('ask-idle', 'idle');
    let resolved: string | undefined;
    const pending = waitForNextIdle('ask-idle', 5_000).then((state) => {
      resolved = state;
      return state;
    });
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    recordPaneSessionState('ask-idle', 'busy');
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    recordPaneSessionState('ask-idle', 'idle');
    await expect(pending).resolves.toBe('idle');
  });

  it('pane já busy resolve no próximo idle (sem esperar outro busy)', async () => {
    stubs.getSessionState.mockReturnValue('busy');
    recordPaneSessionState('ask-busy', 'busy');
    const pending = waitForNextIdle('ask-busy', 5_000);
    recordPaneSessionState('ask-busy', 'idle');
    await expect(pending).resolves.toBe('idle');
  });
});

// F-918: o breaker de mortalidade só conta a CLI que saiu sozinha —
// exit precisa ter sido observado NESTE processo e o pane não pode ter
// sido fechado por pedido.
describe('exit observado × fechamento deliberado (F-918)', () => {
  it('sessão sem exit observado não prova morte espontânea', () => {
    expect(wasPaneSessionExitObserved('sessao-nunca-vista')).toBe(false);
    expect(wasPaneSessionExitObserved('')).toBe(false);
  });

  it('recordPaneSessionExit marca o exit como observado, além do TTL do buffer', () => {
    recordPaneSessionExit('sessao-morta-918');
    expect(wasPaneSessionExitObserved('sessao-morta-918')).toBe(true);
    __evictExitedBufferForTests('sessao-morta-918');
    expect(wasPaneSessionExitObserved('sessao-morta-918')).toBe(true);
  });

  it('fechamento deliberado é por paneId e começa falso', () => {
    __resetDeliberatelyClosedPanesForTests();
    expect(wasPaneDeliberatelyClosed('pane-918')).toBe(false);
    markPaneDeliberatelyClosed('pane-918');
    expect(wasPaneDeliberatelyClosed('pane-918')).toBe(true);
    expect(wasPaneDeliberatelyClosed('pane-outro')).toBe(false);
    // Close fire-and-forget: só desculpa o exit logo depois do pedido; a CLI
    // que seguiu viva e morreu sozinha minutos depois conta para o breaker.
    const markedAt = Date.now();
    expect(wasPaneDeliberatelyClosed('pane-918', markedAt + 5_000)).toBe(true);
    expect(wasPaneDeliberatelyClosed('pane-918', markedAt + 10 * 60_000)).toBe(false);
    expect(wasPaneDeliberatelyClosed('pane-918', markedAt - 60_000)).toBe(false);
    __resetDeliberatelyClosedPanesForTests();
    expect(wasPaneDeliberatelyClosed('pane-918')).toBe(false);
  });
});

describe('newOutputSince — resposta do nexus_pane_ask', () => {
  it('devolve só o texto depois da âncora (última linha do before)', () => {
    const before = 'boot banner\n> prompt anterior\nresposta velha\n';
    const after = 'boot banner\n> prompt anterior\nresposta velha\nQuanto é 1+1?\n2\n';
    expect(newOutputSince(before, after)).toBe('Quanto é 1+1?\n2\n');
  });

  it('janela que rolou além da âncora devolve o after inteiro', () => {
    expect(newOutputSince('linha antiga\n', 'só coisa nova\n2\n')).toBe('só coisa nova\n2\n');
  });

  it('before vazio devolve o after inteiro', () => {
    expect(newOutputSince('', 'primeira resposta\n')).toBe('primeira resposta\n');
  });

  it('âncora repetida usa a ÚLTIMA ocorrência', () => {
    const before = 'ok\nfim\n';
    const after = 'fim\nmeio\nfim\nnovo\n';
    expect(newOutputSince(before, after)).toBe('novo\n');
  });
});


// Run the actual exported reader off-thread: the unfixed MAX_SAFE_INTEGER loop
// must never trap Vitest's process. Only its analysis dependency is substituted.
async function readAnalysisOffThread(text: string, lines: number): Promise<string> {
  const reader = readSessionOutput.toString()
    .replace(/\b[\w$]+\.isPtyAnalysisEnabled/g, 'isPtyAnalysisEnabled')
    .replace(/\b[\w$]+\.analysisClient/g, 'analysisClient');
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const isPtyAnalysisEnabled = () => true;
    const analysisClient = { text: () => ${JSON.stringify(text)}, status: () => 'active' };
    const read = (${reader});
    parentPort.postMessage(read('synthetic-boot', ${String(lines)}));
  `, { eval: true });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('session output reader exceeded its bounded worker deadline'));
    }, 2000);
    worker.once('message', (result: string) => { clearTimeout(timeout); void worker.terminate(); resolve(result); });
    worker.once('error', (error) => { clearTimeout(timeout); void worker.terminate(); reject(error); });
  });
}

describe('analysis output tail terminates at the first character', () => {
  it('leading newline with MAX_SAFE_INTEGER returns promptly instead of looping at index zero', async () => {
    await expect(readAnalysisOffThread('\nSynthetic boot error', Number.MAX_SAFE_INTEGER)).resolves.toBe('\nSynthetic boot error');
  });

  it('ordinary tails keep requested line semantics, including empty and excess requests', () => {
    stubs.analysisEnabled.mockReturnValue(true);
    try {
      for (const text of ['\nfirst\nlast', 'first\nlast', '\n', '']) {
        stubs.analysisText.mockReturnValue(text);
        for (const lines of [0, 1, 2, 4]) {
          expect(readSessionOutput('synthetic', lines)).toBe(text.split('\n').slice(Math.max(0, text.split('\n').length - lines)).join('\n'));
        }
      }
    } finally { stubs.analysisEnabled.mockReturnValue(false); }
  });
});

it('normalizes invalid line counts consistently without truncating intentional all-lines reads', async () => {
  await expect(readAnalysisOffThread('\nSynthetic boot error', Infinity)).resolves.toBe('\nSynthetic boot error');
  stubs.analysisEnabled.mockReturnValue(true);
  stubs.analysisText.mockReturnValue('first\nsecond\nlast');
  try {
    for (const lines of [NaN, -Infinity, -1, 0]) expect(readSessionOutput('synthetic', lines)).toBe('');
    expect(readSessionOutput('synthetic', 2.8)).toBe('second\nlast');
  } finally { stubs.analysisEnabled.mockReturnValue(false); }
});

describe('cópia do output em Main (#13)', () => {
  const withAnalysis = (status: string | null, run: () => void, enabled = true) => {
    stubs.analysisEnabled.mockReturnValue(enabled);
    stubs.analysisStatus.mockReturnValue(status);
    try { run(); } finally { stubs.analysisEnabled.mockReturnValue(false); stubs.analysisStatus.mockReturnValue('active'); }
  };

  it('sessão que a análise espelha (active ou sealed) não retém um segundo ring de 256 KB', () => {
    for (const status of ['active', 'sealed']) {
      const id = `espelhada-${status}`;
      withAnalysis(status, () => recordPaneSessionData(id, 'duplicado\n'));
      // Sem análise o leitor cai no ring: a sessão espelhada não deixou nada nele.
      expect(readSessionOutput(id, 10)).toBe('');
    }
    // O estado da sessão (saída, última escrita) continua registrado.
    recordPaneSessionExit('espelhada-active');
    expect(wasPaneSessionExitObserved('espelhada-active')).toBe(true);
  });

  it('sessão degradada, terminada, desconhecida ou com a análise desligada continua no ring', () => {
    for (const status of ['degraded', 'terminated', null]) {
      const id = `no-ring-${String(status)}`;
      withAnalysis(status, () => recordPaneSessionData(id, 'so no ring\n'));
      expect(readSessionOutput(id, 10)).toBe('so no ring\n');
    }
    withAnalysis('active', () => recordPaneSessionData('analise-desligada', 'apos shutdown\n'), false);
    expect(readSessionOutput('analise-desligada', 10)).toBe('apos shutdown\n');
  });

  it('readSessionOutput serve o espelho só com a sessão saudável; degradada, terminada ou após shutdown, devolve o espelho congelado + o ring novo', () => {
    stubs.analysisText.mockReturnValue('antes da degradação\n');
    try {
      withAnalysis('active', () => expect(readSessionOutput('lida', 10)).toBe('antes da degradação\n'));
      withAnalysis('sealed', () => expect(readSessionOutput('lida', 10)).toBe('antes da degradação\n'));
      // Degradou: o espelho parou, o ring passa a receber o que vier depois.
      withAnalysis('degraded', () => recordPaneSessionData('lida', 'depois\n'));
      for (const [status, enabled] of [['degraded', true], ['terminated', true], ['degraded', false]] as const) {
        withAnalysis(status, () => expect(readSessionOutput('lida', 10)).toBe('antes da degradação\ndepois\n'), enabled);
      }
    } finally { stubs.analysisText.mockReturnValue(''); }
  });
});
