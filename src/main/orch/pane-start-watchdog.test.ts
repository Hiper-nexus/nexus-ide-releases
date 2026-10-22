/**
 * F-723: o Nexus confere se o pane que soltou começou a tarefa. Decisão pura
 * (`decideStartAction`), texto do aviso e a ficha em memória.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  MAIN_PRESSURE_SETTLE_MS,
  START_GRACE_MS,
  CREDENTIAL_REJECTED_OPEN_MS,
  applyStartFailureBreaker,
  loginScreenAccountPauseReason,
  decideStartAction,
  getPaneStartWatch,
  notePaneSessionEnded,
  notePaneStartAccepted,
  notePaneStartFailure,
  notePaneStartPressure,
  notePaneTurnEnded,
  notStartedCause,
  paneStartNoticeSummary,
  paneStartProgress,
  providerLoginDetail,
  providerLoginScreen,
  providerRejectedCause,
  paneStartBusyContradiction,
  releasePaneStartWatch,
  resetPaneStartWatchdogForTests,
  sessionBusyContradiction,
  setPaneStartBusyEvidence,
  setPaneStartKick,
  shortStartError,
  startFailureBreakerAction,
  trackPaneStart,
  type StartCheckInput,
} from './pane-start-watchdog';
import { CircuitBreakerRegistry } from './circuit-breaker';

const NOW = 50_000_000;

function input(overrides: Partial<StartCheckInput> = {}): StartCheckInput {
  return {
    role: 'worker',
    operatorOpened: false,
    started: false,
    failed: false,
    session: 'idle',
    canJudgeLiveSession: true,
    spawnedAt: NOW - START_GRACE_MS - 1_000,
    redeliveredAt: null,
    rerouted: false,
    pinnedRuntime: false,
    hasAlternative: true,
    now: NOW,
    ...overrides,
  };
}

describe('decideStartAction (F-723)', () => {
  it('pane que começou a tarefa: nada a fazer', () => {
    expect(decideStartAction(input({ started: true }))).toBe('none');
    expect(decideStartAction(input({ started: true, failed: true }))).toBe('none');
  });

  it('sessão viva, ociosa e sem turno depois da graça: reenvia o brief uma vez', () => {
    expect(decideStartAction(input())).toBe('redeliver');
    // Dentro da graça ainda é boot.
    expect(decideStartAction(input({ spawnedAt: NOW - 10_000 }))).toBe('none');
  });

  it('ainda sem turno uma graça depois do reenvio: manda para outra CLI', () => {
    expect(
      decideStartAction(input({ redeliveredAt: NOW - START_GRACE_MS })),
    ).toBe('reroute');
    // Reenvio recente: espera a nova graça, não reenvia de novo.
    expect(decideStartAction(input({ redeliveredAt: NOW - 30_000 }))).toBe('none');
  });

  it('nenhuma sessão nasceu na graça: manda para outra CLI', () => {
    expect(decideStartAction(input({ session: 'none' }))).toBe('reroute');
    expect(
      decideStartAction(input({ session: 'none', spawnedAt: NOW - 20_000 })),
    ).toBe('none');
  });

  it('falha física provada (spawn recusado, saída no boot) não espera a graça', () => {
    expect(
      decideStartAction(input({ failed: true, session: 'none', spawnedAt: NOW - 2_000 })),
    ).toBe('reroute');
  });

  it('PTY ocupado ou CLI sem prova de turno: sessão viva não é julgada', () => {
    expect(decideStartAction(input({ session: 'busy' }))).toBe('none');
    expect(decideStartAction(input({ canJudgeLiveSession: false }))).toBe('none');
    // Mas falha provada vale para qualquer CLI.
    expect(
      decideStartAction(input({ canJudgeLiveSession: false, failed: true })),
    ).toBe('reroute');
  });

  it('pane aberto pelo operador (F-231): só avisa, nunca reenvia nem fecha', () => {
    expect(decideStartAction(input({ operatorOpened: true }))).toBe('notify-only');
    expect(
      decideStartAction(input({ operatorOpened: true, failed: true })),
    ).toBe('notify-only');
  });

  it('orquestrador e o pane do próprio operador nunca são vigiados', () => {
    for (const role of ['orchestrator', 'operator'] as const) {
      expect(decideStartAction(input({ role }))).toBe('none');
      expect(decideStartAction(input({ role, failed: true }))).toBe('none');
      expect(decideStartAction(input({ role, session: 'none' }))).toBe('none');
    }
  });

  it('já é o reenvio automático de outro pedido: só avisa (sem laço)', () => {
    expect(decideStartAction(input({ rerouted: true, failed: true }))).toBe('notify-only');
    expect(
      decideStartAction(input({ rerouted: true, redeliveredAt: NOW - START_GRACE_MS })),
    ).toBe('notify-only');
    // O reenvio do brief ("corrigir ali") ainda vale para ele.
    expect(decideStartAction(input({ rerouted: true }))).toBe('redeliver');
  });

  it('nenhuma outra CLI disponível: só avisa', () => {
    expect(
      decideStartAction(input({ hasAlternative: false, failed: true })),
    ).toBe('notify-only');
  });

  it('CLI pedida pelo operador ou retomada de conversa: não troca sozinho', () => {
    expect(
      decideStartAction(input({ pinnedRuntime: true, session: 'none' })),
    ).toBe('notify-only');
  });

  it('brief recusado numa retomada sem pin do operador: reabre uma vez', () => {
    expect(decideStartAction(input({
      failed: true,
      pinnedRuntime: true,
      operatorPinned: false,
      failureCause: 'brief-rejected',
      generation: 0,
    }))).toBe('reroute');
  });

  it('CLI pedida pelo operador: brief recusado só avisa', () => {
    expect(decideStartAction(input({
      failed: true,
      pinnedRuntime: true,
      operatorPinned: true,
      failureCause: 'brief-rejected',
    }))).toBe('notify-only');
  });

  it('brief recusado já reaberto: não troca de novo', () => {
    expect(decideStartAction(input({
      failed: true,
      operatorPinned: false,
      failureCause: 'brief-rejected',
      generation: 1,
    }))).toBe('notify-only');
  });

  it('outra falha numa retomada continua só avisando', () => {
    expect(decideStartAction(input({
      failed: true,
      session: 'none',
      pinnedRuntime: true,
      operatorPinned: false,
      failureCause: 'boot-exit',
    }))).toBe('notify-only');
  });
});

describe('turno do brief recusado pelo provedor (F-734)', () => {
  const progress = (
    overrides: Partial<Parameters<typeof paneStartProgress>[0]> = {},
  ) =>
    paneStartProgress({
      turnProof: true,
      turnOpened: true,
      worked: false,
      lastTurnEnd: null,
      ...overrides,
    });

  it('só credencial, conta e pedido recusados viram falha de início', () => {
    expect(providerRejectedCause('auth')).toBe('provider-auth');
    expect(providerRejectedCause('billing')).toBe('provider-billing');
    expect(providerRejectedCause('invalid_request')).toBe('provider-request');
    // Limite de uso e transitórios são do failover (F-249/F-718).
    expect(providerRejectedCause('other')).toBeNull();
    expect(providerRejectedCause(undefined)).toBeNull();
  });

  it('família Claude: turno aberto sem trabalho nem fim espera o desfecho', () => {
    expect(progress()).toEqual({ kind: 'turn-open' });
    expect(progress({ turnOpened: false })).toEqual({ kind: 'none' });
  });

  it('ferramenta, handoff ou Stop normal provam o início', () => {
    expect(progress({ worked: true })).toEqual({ kind: 'started' });
    expect(
      progress({ worked: true, lastTurnEnd: { outcome: 'error', stopFailure: 'auth' } }),
    ).toEqual({ kind: 'started' });
    expect(progress({ lastTurnEnd: { outcome: 'completed' } })).toEqual({ kind: 'started' });
  });

  it('StopFailure de configuração sem trabalho: recusa; limite ou transitório: não é deste watchdog', () => {
    expect(progress({ lastTurnEnd: { outcome: 'error', stopFailure: 'auth' } })).toEqual({
      kind: 'rejected',
      cause: 'provider-auth',
    });
    expect(
      progress({ lastTurnEnd: { outcome: 'error', stopFailure: 'invalid_request' } }),
    ).toEqual({ kind: 'rejected', cause: 'provider-request' });
    expect(progress({ lastTurnEnd: { outcome: 'error', stopFailure: 'other' } })).toEqual({
      kind: 'not-ours',
    });
    expect(progress({ lastTurnEnd: { outcome: 'error' } })).toEqual({ kind: 'not-ours' });
  });

  it('CLI sem prova de turno segue o F-723: turno aberto (assentado) já é início', () => {
    expect(progress({ turnProof: false })).toEqual({ kind: 'started' });
    expect(progress({ turnProof: false, turnOpened: false })).toEqual({ kind: 'none' });
    // F-765: enquanto assenta, só espera — a recusa do provedor chega em segundos.
    expect(progress({ turnProof: false, settling: true })).toEqual({ kind: 'turn-open' });
  });

  it('F-765: só a EVIDÊNCIA de recusa segura uma CLI sem prova de turno', () => {
    // Recusa do modelo no PTY, sem trabalho: a ficha espera o failover.
    expect(progress({ turnProof: false, modelRejected: true })).toEqual({ kind: 'turn-open' });
    expect(progress({
      turnProof: false,
      modelRejected: true,
      lastTurnEnd: { outcome: 'error' },
    })).toEqual({ kind: 'turn-open' });
    // Turno fechado com erro e sem trabalho não é início (é do failover).
    expect(progress({ turnProof: false, lastTurnEnd: { outcome: 'error' } })).toEqual({ kind: 'not-ours' });
    // Trabalho e fim normal continuam provando início.
    expect(progress({ turnProof: false, worked: true, modelRejected: true })).toEqual({ kind: 'started' });
    expect(progress({ turnProof: false, lastTurnEnd: { outcome: 'completed' } })).toEqual({ kind: 'started' });
  });

  it('disjuntor: credencial sem conta gerenciada abre; com conta ou pedido recusado, só conta', () => {
    for (const cause of ['provider-auth', 'provider-billing'] as const) {
      expect(startFailureBreakerAction({ cause, accountBound: false })).toBe('trip');
      expect(startFailureBreakerAction({ cause, accountBound: true })).toBe('count');
    }
    expect(
      startFailureBreakerAction({ cause: 'provider-request', accountBound: false }),
    ).toBe('count');
    expect(startFailureBreakerAction({ cause: 'spawn-refused', accountBound: false })).toBe(
      'count',
    );
  });

  // F-1477: o Grok com OAuth vencido parava em "Approve in your browser to
  // finish signing in…" — turn-not-started contava 1 falha e a rota mandava a
  // próxima tarefa ao mesmo Grok, que morria igual. Revisão Codex: só frases
  // inteiras da tela de login, URL de login e código de dispositivo.
  it('F-1477: tela de login do provedor no fim da saída é reconhecida', () => {
    for (const screen of [
      'Grok CLI v1.4\n\n⠋ Approve in your browser to finish signing in…',
      'Opening https://accounts.x.ai/device …',
      'Visit https://auth.openai.com/oauth/authorize?client_id=x',
      '! First copy your one-time code: ABCD-1234',
      '› Sign in with Google',
      '  Select login method:',
    ]) {
      expect(providerLoginScreen(screen)).toBe(true);
    }
  });

  it('F-1477: frase solta de trabalho ecoado, prosa citada e login antigo não contam', () => {
    for (const screen of [
      // Falsos positivos achados na revisão Codex (conteúdo de trabalho ecoado).
      'Login required is the literal banner under review',
      'Waiting for approval of the merge request',
      // Frases soltas, sem a tela inteira.
      '│ Login required',
      'Please log in to continue.',
      '  Waiting for approval…',
      'O pane mostrou "Approve in your browser to finish signing in" ontem.',
      '- a CLI dizia `Approve in your browser to finish signing in` antes',
      'Sign in with Google é o botão que vamos estilizar',
      'Visit https://example.com/docs to read the guide',
      // Código de dispositivo citado ou no meio de uma frase longa não é tela.
      'O teste usa "code: ABCD-1234" como exemplo de dispositivo',
      'Na revisão do fluxo de pareamento, o ticket diz que o code ABCD-1234 expira',
      ['Approve in your browser to finish signing in…', ...Array.from({ length: 12 }, (_, i) => `linha de trabalho ${i}`)].join('\n'),
      '',
    ]) {
      expect(providerLoginScreen(screen)).toBe(false);
    }
    expect(providerLoginScreen(null)).toBe(false);
  });

  it('F-1477: login com conta gerenciada é estado da conta; sem conta, abre o disjuntor da CLI', () => {
    // A regra do F-734 vale para a tela de login: conta gerenciada só conta no
    // adapter (a pausa é da conta); login nativo é a chave global.
    expect(startFailureBreakerAction({ cause: 'provider-auth', accountBound: true })).toBe('count');
    expect(startFailureBreakerAction({ cause: 'provider-auth', accountBound: false })).toBe('trip');
    expect(loginScreenAccountPauseReason('grok')).toMatch(/session expired/);
    expect(providerLoginDetail('grok', false)).toContain('grok precisa de login');
    expect(providerLoginDetail('grok', true)).toContain('nesta conta');
  });

  it('F-1477 (F-736): sonda half-open que cai de novo segue o recuo em vez de reabrir 15 min', () => {
    let now = 1_000_000;
    const breakers = new CircuitBreakerRegistry({}, () => now);
    applyStartFailureBreaker(breakers, 'grok', 'trip');
    expect(breakers.isOpen('grok')).toBe(true);
    now += CREDENTIAL_REJECTED_OPEN_MS;
    expect(breakers.state('grok')).toBe('half-open');
    applyStartFailureBreaker(breakers, 'grok', 'trip');
    // Recuo ×4 (até 30 min): 20 min depois ainda aberto; o trip fixo já
    // estaria em half-open aos 15 min.
    now += 20 * 60_000;
    expect(breakers.isOpen('grok')).toBe(true);
    // `count` só conta e `skipped` não toca no disjuntor.
    const fresh = new CircuitBreakerRegistry({}, () => now);
    applyStartFailureBreaker(fresh, 'kimi', 'count');
    applyStartFailureBreaker(fresh, 'kimi', 'skipped');
    expect(fresh.snapshot('kimi')).toMatchObject({ state: 'closed', recentFailures: 1 });
  });

  // F-1534: campo 14/10 — com o Main sob carga, spawn recusado por pressão da
  // máquina contava como falha da CLI (disjuntor F-736 + reenvio para uma CLI
  // de qualidade menor). Nenhum dos dois pode acontecer.
  describe('F-1534: pressão da Main não é falha da CLI', () => {
    it('recusa por pressão não toca o disjuntor do adapter', () => {
      expect(startFailureBreakerAction({ cause: 'main-pressure-refused', accountBound: false })).toBe(
        'skipped',
      );
      expect(startFailureBreakerAction({ cause: 'main-pressure-refused', accountBound: true })).toBe(
        'skipped',
      );
    });

    it('aviso de pressão diz que a máquina estava no limite (não a CLI)', () => {
      const summary = paneStartNoticeSummary({
        paneId: 'pane-grok',
        adapterId: 'grok',
        cause: 'main-pressure-refused',
        outcome: { kind: 'not-rerouted', why: 'pressure' },
        detail: 'o Main está encerrando as PTYs',
      });
      expect(summary).toContain('a máquina ou o Nexus estava no limite');
      expect(summary).toContain('Motivo: o Main está encerrando as PTYs.');
      expect(summary).not.toContain('Reenviada para');
      expect(summary).toContain('não reenviei para outra CLI');
    });

    it('pane vivo sem turno sob pressão: espera o assentamento antes de mandar para outro', () => {
      const pressureSince = NOW - 30_000;
      // Veredito por PRAZO (não por falha provada) + Main saturado: espera.
      expect(
        decideStartAction(input({ redeliveredAt: NOW - START_GRACE_MS, mainPressure: true, pressureSince })),
      ).toBe('none');
      // Pressão já assentada (passou o prazo): age como sempre.
      expect(
        decideStartAction(input({
          redeliveredAt: NOW - START_GRACE_MS,
          mainPressure: true,
          pressureSince: NOW - MAIN_PRESSURE_SETTLE_MS - 1_000,
        })),
      ).toBe('reroute');
      // Sem pressão: o prazo vale, como antes do F-1534.
      expect(decideStartAction(input({ redeliveredAt: NOW - START_GRACE_MS }))).toBe('reroute');
    });

    it('falha PROVADA da CLI não espera a pressão acabar', () => {
      expect(
        decideStartAction(input({
          failed: true,
          mainPressure: true,
          pressureSince: NOW - 1_000,
        })),
      ).toBe('reroute');
    });

    it('a pressão só segura o prazo depois de vista de verdade', () => {
      // `mainPressure` ligado sem `pressureSince` (nunca observado) não segura.
      expect(
        decideStartAction(input({ redeliveredAt: NOW - START_GRACE_MS, mainPressure: true, pressureSince: null })),
      ).toBe('reroute');
    });

    it('a ficha guarda quando a pressão apareceu', () => {
      const watch = trackPaneStart({
        paneId: 'pane-pressao',
        requestId: 'orchspawn-pressao',
        adapterId: 'agy',
        scope: testProjectScope(),
        missionId: 'mission-a',
        role: 'worker',
        callerSessionId: 'session-maestro',
        turnProof: false,
        pinnedRuntime: false,
        rerouted: false,
        createdAt: NOW,
      });
      expect(watch.pressureSince).toBeNull();
      notePaneStartPressure(watch, NOW - 1_000);
      expect(watch.pressureSince).toBe(NOW - 1_000);
      // Uma pressão que já passou não volta a marcar o começo.
      notePaneStartPressure(watch, NOW - 5_000);
      expect(watch.pressureSince).toBe(NOW - 1_000);
    });
  });

  it('aviso: categoria do motivo, nunca texto do provedor', () => {
    const summary = paneStartNoticeSummary({
      paneId: 'pane-ds',
      adapterId: 'deepseek',
      cause: 'provider-auth',
      outcome: { kind: 'rerouted', paneId: 'pane-novo', adapterId: 'codex' },
    });
    expect(summary).toBe(
      '[nao-iniciou:pane-ds] O pane pane-ds (deepseek) não começou a tarefa: ' +
        'credencial recusada pelo provedor (o turno do brief acabou antes de ' +
        'qualquer trabalho). Reenviada para codex (pane pane-novo).',
    );
    expect(
      paneStartNoticeSummary({
        paneId: 'p',
        adapterId: 'glm',
        cause: 'provider-billing',
        outcome: { kind: 'not-rerouted', why: 'pinned' },
      }),
    ).toContain('conta recusada pelo provedor — cobrança, crédito ou bloqueio');
    expect(
      paneStartNoticeSummary({
        paneId: 'p',
        adapterId: 'claude',
        cause: 'provider-request',
        outcome: { kind: 'not-rerouted', why: 'no-alternative' },
      }),
    ).toContain('pedido recusado pelo provedor — modelo ou parâmetro inválido');
  });
});

describe('aviso a quem pediu (F-723)', () => {
  it('reroteado: ids, adapter, motivo e o pane novo', () => {
    expect(
      paneStartNoticeSummary({
        paneId: 'pane-qwen',
        adapterId: 'qwen',
        cause: 'spawn-refused',
        outcome: { kind: 'rerouted', paneId: 'pane-novo', adapterId: 'codex' },
      }),
    ).toBe(
      '[nao-iniciou:pane-qwen] O pane pane-qwen (qwen) não começou a tarefa: ' +
        'o CLI não subiu (o spawn foi recusado). Reenviada para codex (pane pane-novo).',
    );
  });

  it('sem alternativa: pede a decisão', () => {
    const summary = paneStartNoticeSummary({
      paneId: 'pane-1',
      adapterId: 'kimi',
      cause: notStartedCause({ failure: null, hasSession: false }),
      outcome: { kind: 'not-rerouted', why: 'no-alternative' },
    });
    expect(summary).toContain('nenhuma sessão nasceu em 90 s');
    expect(summary).toContain('Nenhuma outra CLI está disponível — decida.');
  });

  it('motivo curto do erro: 1ª linha, sem segredo, com teto', () => {
    const error = new Error(
      'falhou com Bearer abcdefghijklmnopqrstuvwxyz token sk-proj-ABCDEFGHIJKLMNOP\nlinha 2',
    );
    const short = shortStartError(error);
    expect(short).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(short).not.toContain('sk-proj-ABCDEFGHIJKLMNOP');
    expect(short).not.toContain('linha 2');
    expect(shortStartError('x'.repeat(400)).length).toBeLessThanOrEqual(160);
  });
});

describe('ficha do spawn pendente (F-723)', () => {
  afterEach(() => {
    resetPaneStartWatchdogForTests();
    vi.useRealTimers();
  });

  const base = () => ({
    paneId: 'pane-a',
    requestId: 'orchspawn-a',
    adapterId: 'claude',
    scope: testProjectScope(),
    missionId: 'mission-a',
    role: 'worker' as const,
    callerSessionId: 'session-maestro',
    turnProof: true,
    pinnedRuntime: false,
    rerouted: false,
    createdAt: NOW,
  });

  it('falha que chega antes da ficha (corrida com a resposta da tool) não se perde', () => {
    const at = Date.now();
    notePaneStartFailure('pane-a', 'spawn-refused', at);
    const watch = trackPaneStart(base());
    expect(watch.failure).toEqual({ cause: 'spawn-refused', at });
  });

  it('entrega comprovada do brief dá o pane por iniciado; falha depois não reverte', () => {
    const watch = trackPaneStart(base());
    notePaneStartAccepted('pane-a');
    notePaneStartFailure('pane-a', 'brief-rejected');
    expect(watch.accepted).toBe(true);
    expect(watch.failure).toBeNull();
  });

  it('falha provada pede a varredura imediata (não espera os 15 s)', () => {
    vi.useFakeTimers();
    const kick = vi.fn();
    setPaneStartKick(kick);
    trackPaneStart(base());
    notePaneStartFailure('pane-a', 'spawn-refused');
    expect(kick).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('processo que saiu sozinho no boot, sem turno, não começou', () => {
    const watch = trackPaneStart(base());
    notePaneSessionEnded(watch, {
      sessionId: 'session-a',
      requested: false,
      oneShot: false,
      spawnedAt: NOW,
      started: false,
      now: NOW + 5_000,
    });
    expect(watch.sessionId).toBe('session-a');
    expect(watch.failure).toEqual({ cause: 'boot-exit', at: NOW + 5_000 });
  });

  it('F-792: one-shot que saiu sozinho com erro ou sinal no boot, sem turno, não começou', () => {
    for (const exit of [{ exitCode: 1, signal: 0 }, { exitCode: 0, signal: 9 }]) {
      resetPaneStartWatchdogForTests();
      const watch = trackPaneStart(base());
      notePaneSessionEnded(watch, {
        sessionId: 'session-a',
        requested: false,
        oneShot: true,
        exit,
        spawnedAt: NOW,
        started: false,
        now: NOW + 4_276,
      });
      expect(watch.failure).toEqual({ cause: 'boot-exit', at: NOW + 4_276, exitCode: exit.exitCode });
      expect(watch.sessionEnded).toBe(false);
    }
  });

  it('encerramento pedido, one-shot que terminou e morte tardia não são falha de início', () => {
    const cases = [
      { requested: true, oneShot: false, now: NOW + 5_000 },
      { requested: false, oneShot: true, exit: { exitCode: 0, signal: 0 }, now: NOW + 5_000 },
      // Sem a saída da raiz não há prova de morte: o one-shot terminou.
      { requested: false, oneShot: true, exit: null, now: NOW + 5_000 },
      // Encerramento pedido pelo Nexus num one-shot também não é falha.
      { requested: true, oneShot: true, exit: { exitCode: 1, signal: 0 }, now: NOW + 5_000 },
      { requested: false, oneShot: false, now: NOW + START_GRACE_MS + 1 },
      // F-984: saída LIMPA depois da graça continua sem veredito.
      { requested: false, oneShot: false, exit: { exitCode: 0, signal: 0 }, now: NOW + START_GRACE_MS + 1 },
    ];
    for (const end of cases) {
      resetPaneStartWatchdogForTests();
      const watch = trackPaneStart(base());
      notePaneSessionEnded(watch, {
        sessionId: 'session-a',
        spawnedAt: NOW,
        started: false,
        ...end,
      });
      expect(watch.failure).toBeNull();
      expect(watch.sessionEnded).toBe(true);
    }
  });

  it('F-984: saída com erro DEPOIS da graça, sem início provado, é morte (writers Codex com 74 aos 303 s)', () => {
    for (const end of [
      { oneShot: false, exit: { exitCode: 74, signal: 0 } },
      { oneShot: true, exit: { exitCode: 1, signal: 0 } },
      { oneShot: false, exit: { exitCode: 0, signal: 15 } },
    ]) {
      resetPaneStartWatchdogForTests();
      const watch = trackPaneStart(base());
      notePaneSessionEnded(watch, {
        sessionId: 'session-a',
        requested: false,
        spawnedAt: NOW,
        started: false,
        now: NOW + 303_140,
        ...end,
      });
      expect(watch.failure).toEqual({ cause: 'boot-exit', at: NOW + 303_140, exitCode: end.exit.exitCode });
    }
    // Com início provado (trabalhou) ou encerramento pedido, não.
    for (const end of [{ started: true, requested: false }, { started: false, requested: true }]) {
      resetPaneStartWatchdogForTests();
      const watch = trackPaneStart(base());
      notePaneSessionEnded(watch, {
        sessionId: 'session-a',
        oneShot: false,
        exit: { exitCode: 74, signal: 0 },
        spawnedAt: NOW,
        now: NOW + 303_140,
        ...end,
      });
      expect(watch.failure).toBeNull();
    }
  });

  it('F-1367: saída com erro aos 791 s (acima do teto de boot) vira worker-exit em vez de boot-exit', () => {
    resetPaneStartWatchdogForTests();
    const watch = trackPaneStart(base());
    notePaneSessionEnded(watch, {
      sessionId: 'session-a',
      requested: false,
      spawnedAt: NOW,
      started: false,
      now: NOW + 791_000,
      oneShot: true,
      exit: { exitCode: 3, signal: 0 },
    });
    expect(watch.failure).toEqual({ cause: 'worker-exit', at: NOW + 791_000, exitCode: 3 });
    expect(startFailureBreakerAction({ cause: 'worker-exit' as any, accountBound: false })).toBe('skipped');
  });

  it('a ficha nunca guarda o texto do brief, só a closure de entrega', () => {
    const watch = trackPaneStart({ ...base(), redeliver: async () => true });
    expect(JSON.stringify(watch)).not.toMatch(/brief|prompt/i);
    expect(getPaneStartWatch('pane-a')).toBe(watch);
  });

  it('F-734: StopFailure de credencial sem trabalho é falha provada mesmo com o turno aceito', () => {
    vi.useFakeTimers();
    const kick = vi.fn();
    setPaneStartKick(kick);
    const watch = trackPaneStart({ ...base(), adapterId: 'deepseek' });
    notePaneStartAccepted('pane-a');
    expect(watch.accepted).toBe(true);

    const cause = notePaneTurnEnded(watch, {
      sessionId: 'session-a',
      outcome: 'error',
      stopFailure: 'auth',
      worked: false,
      now: NOW + 70_000,
    });
    expect(cause).toBe('provider-auth');
    expect(watch.sessionId).toBe('session-a');
    expect(watch.failure).toEqual({ cause: 'provider-auth', at: NOW + 70_000 });
    vi.runAllTimers();
    expect(kick).toHaveBeenCalledTimes(1);

    // A primeira falha anotada vale: outro fim de turno não a troca.
    expect(
      notePaneTurnEnded(watch, {
        sessionId: 'session-a',
        outcome: 'error',
        stopFailure: 'billing',
        worked: false,
        now: NOW + 80_000,
      }),
    ).toBeNull();
    expect(watch.failure?.cause).toBe('provider-auth');
  });

  it('F-765: fim de turno com modelo recusado conserva a ficha para o failover', () => {
    const watch = trackPaneStart({ ...base(), adapterId: 'codex', turnProof: false });
    notePaneStartAccepted('pane-a');
    expect(notePaneTurnEnded(watch, {
      sessionId: 'session-codex',
      outcome: 'error',
      stopFailure: 'invalid_request',
      modelRejected: true,
      worked: false,
      now: NOW,
    })).toBeNull();
    expect(watch.failure).toBeNull();
    expect(watch.turnOutcome).toBeNull();
    expect(watch.phase).toBe('watching');
    expect(watch.modelRejectedAt).toBe(NOW);
  });

  it('F-765: CLI sem prova de turno — fim de turno sem recusa decide como o F-723', () => {
    const watch = trackPaneStart({ ...base(), adapterId: 'codex', turnProof: false });
    notePaneStartAccepted('pane-a', NOW);
    expect(watch.turnOpenedAt).toBe(NOW);
    expect(notePaneTurnEnded(watch, {
      sessionId: 'session-codex', outcome: 'error', worked: false, now: NOW + 1_000,
    })).toBeNull();
    expect(watch.turnOutcome).toBe('not-ours');
    resetPaneStartWatchdogForTests();
    const ok = trackPaneStart({ ...base(), adapterId: 'codex', turnProof: false });
    notePaneTurnEnded(ok, {
      sessionId: 'session-codex', outcome: 'completed', worked: false, now: NOW,
    });
    expect(ok.turnOutcome).toBe('started');
  });

  it('F-765: o failover assume o pane — a ficha sai sem veredito e uma só vez', () => {
    const watch = trackPaneStart({ ...base(), adapterId: 'codex', turnProof: false });
    expect(releasePaneStartWatch('pane-a')).toBe(true);
    expect(watch.phase).toBe('done');
    expect(getPaneStartWatch('pane-a')).toBeNull();
    expect(releasePaneStartWatch('pane-a')).toBe(false);
  });

  it('F-734: trabalho no turno, Stop normal, limite ou transitório não são falha de início', () => {
    const cases = [
      { outcome: 'error' as const, stopFailure: 'auth' as const, worked: true, expected: 'started' },
      { outcome: 'completed' as const, worked: false, expected: 'started' },
      { outcome: 'error' as const, stopFailure: 'other' as const, worked: false, expected: 'not-ours' },
      { outcome: 'error' as const, worked: false, expected: 'not-ours' },
    ];
    for (const { expected, ...end } of cases) {
      resetPaneStartWatchdogForTests();
      const watch = trackPaneStart(base());
      expect(
        notePaneTurnEnded(watch, { sessionId: 'session-a', now: NOW, ...end }),
      ).toBeNull();
      expect(watch.failure).toBeNull();
      expect(watch.turnOutcome).toBe(expected);
      expect(watch.phase).toBe('watching');
    }
  });

  it('F-734: só o turno do brief é julgado — o turno seguinte nunca reverte o início', () => {
    const watch = trackPaneStart(base());
    notePaneTurnEnded(watch, {
      sessionId: 'session-a',
      outcome: 'completed',
      worked: false,
      now: NOW,
    });
    // O Maestro escreve no pane e o turno seguinte falha: não é falha de início.
    expect(
      notePaneTurnEnded(watch, {
        sessionId: 'session-a',
        outcome: 'error',
        stopFailure: 'invalid_request',
        worked: false,
        now: NOW + 5_000,
      }),
    ).toBeNull();
    expect(watch.failure).toBeNull();
    expect(watch.turnOutcome).toBe('started');
  });
});

describe('a busy worker is not a brief that failed to start', () => {
  afterEach(() => resetPaneStartWatchdogForTests());

  it('tool activity means it works; an open heavy admission means it waits in the queue', () => {
    expect(paneStartBusyContradiction({ toolActivityCount: 2, heavyAdmissionOpen: true })).toBe('working');
    expect(paneStartBusyContradiction({ toolActivityCount: 0, heavyAdmissionOpen: true })).toBe('heavy-queue');
    expect(paneStartBusyContradiction({ toolActivityCount: 0, heavyAdmissionOpen: false })).toBeNull();
  });

  it('reads the Main probes the supervisor registered, and fails open when they are missing or throw', () => {
    expect(sessionBusyContradiction('session-a')).toBeNull();
    setPaneStartBusyEvidence({ toolActivityCount: () => 0, heavyAdmissionOpen: id => id === 'session-a' });
    expect(sessionBusyContradiction('session-a')).toBe('heavy-queue');
    expect(sessionBusyContradiction('session-b')).toBeNull();
    expect(sessionBusyContradiction(null)).toBeNull();
    setPaneStartBusyEvidence({ toolActivityCount: () => { throw new Error('probe'); }, heavyAdmissionOpen: () => true });
    expect(sessionBusyContradiction('session-a')).toBeNull();
  });
});
