import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  armAutoCloseOnHandoff,
  assertAutoCloseReportPreserved,
  armAutoCloseOnHandoffForPane,
  armedAutoClosePaneId,
  closeAfterNonSuccessHandoffAck,
  disarmAutoCloseOnHandoff,
  missionWriterAwaitsHandoffAck,
  NON_SUCCESS_IDLE_CLOSE_MS,
  SUCCESS_ACK_DELIVERY_CEILING_MS,
  SUCCESS_ACK_IDLE_CLOSE_MS,
  selectScopedPaneCloseTargets,
  scheduleAutoCloseAfterHandoff,
  shouldArmAutoCloseOnHandoff,
  shouldAutoCloseAfterHandoff,
} from "./pane-close-scopes";

// Paridade Overclock (gap e): fechamento por ESCOPO explícito — o chamador
// nomeia o que fecha; nada é implícito. Orquestrador e o próprio pane do
// chamador nunca entram; worker de missão RODANDO só cai quando o escopo é a
// própria missão do chamador (dono limpando os próprios workers).
describe("selectScopedPaneCloseTargets", () => {
  const panes = [
    { paneId: "p-caller", sessionId: "s-caller", missionId: "m1", role: "worker" as const, scopeRoot: "/ws" },
    { paneId: "p-orch", sessionId: "s-orch", missionId: "m1", role: "orchestrator" as const, scopeRoot: "/ws" },
    { paneId: "p-w1", sessionId: "s-w1", missionId: "m1", role: "worker" as const, scopeRoot: "/ws" },
    { paneId: "p-w2", sessionId: "s-w2", missionId: "m2", role: "worker" as const, scopeRoot: "/ws" },
    { paneId: "p-free", sessionId: "s-free", scopeRoot: "/ws" },
    { paneId: "p-other-ws", sessionId: "s-x", scopeRoot: "/outro" },
  ];

  it("caller_mission fecha só os panes da missão do chamador, nunca o orquestrador nem ele mesmo", () => {
    const result = selectScopedPaneCloseTargets({
      scope: "caller_mission",
      callerSessionId: "s-caller",
      callerMissionId: "m1",
      callerScopeRoot: "/ws",
      panes,
      isMissionRunning: () => true,
    });
    expect(result.close).toEqual(["p-w1"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paneId: "p-caller", reason: "caller" }),
        expect.objectContaining({ paneId: "p-orch", reason: "orchestrator" }),
      ]),
    );
  });

  it("caller_workspace fecha os panes do workspace mas preserva workers de OUTRA missão rodando", () => {
    const result = selectScopedPaneCloseTargets({
      scope: "caller_workspace",
      callerSessionId: "s-caller",
      callerMissionId: "m1",
      callerScopeRoot: "/ws",
      panes,
      isMissionRunning: (missionId) => missionId === "m2",
    });
    expect(result.close).toEqual(["p-w1", "p-free"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paneId: "p-w2", reason: "mission-running" }),
      ]),
    );
    expect(result.close).not.toContain("p-other-ws");
  });

  it("F-231: pane aberto pelo operador nunca entra no scope-close do Maestro", () => {
    const withOperator = [
      ...panes,
      {
        paneId: "p-operator",
        sessionId: "s-operator",
        missionId: "m1",
        role: "worker" as const,
        operatorOpened: true,
        scopeRoot: "/ws",
      },
    ];
    const result = selectScopedPaneCloseTargets({
      scope: "caller_mission",
      callerSessionId: "s-caller",
      callerMissionId: "m1",
      callerScopeRoot: "/ws",
      panes: withOperator,
      isMissionRunning: () => true,
    });
    expect(result.close).toEqual(["p-w1"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paneId: "p-operator", reason: "operator-opened" }),
      ]),
    );
  });

  it("caller_mission sem missionId do chamador não fecha nada", () => {
    const result = selectScopedPaneCloseTargets({
      scope: "caller_mission",
      callerSessionId: "s-caller",
      callerScopeRoot: "/ws",
      panes,
      isMissionRunning: () => false,
    });
    expect(result.close).toEqual([]);
  });
});

describe("scheduleAutoCloseAfterHandoff", () => {
  it.each([' ', ' | ', '; '])('rejects multiple JWT redactions separated by %j without report context', (separator) => {
    armAutoCloseOnHandoff('jwt-pair', 'pane-jwt');
    try {
      const summary = 'Pesquisa concluída, veja os detalhes.';
      const jwt = 'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(16) + '.' + 'c'.repeat(16);
      expect(() => assertAutoCloseReportPreserved('jwt-pair', 'pane-jwt', 'success', {
        summary, fullText: summary,
      }, () => `${jwt}${separator}${jwt}`)).toThrow('handoff_report_required');
      expect(armedAutoClosePaneId('jwt-pair')).toBe('pane-jwt');
    } finally { disarmAutoCloseOnHandoff('jwt-pair', 'pane-jwt'); }
  });
  it('does not close on a JWT redaction marker with no report context', () => {
    armAutoCloseOnHandoff('jwt-only', 'pane-jwt');
    try {
      const summary = 'Pesquisa concluída, veja os detalhes.';
      const jwt = 'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(16) + '.' + 'c'.repeat(16);
      expect(() => assertAutoCloseReportPreserved('jwt-only', 'pane-jwt', 'success', {
        summary, fullText: summary,
      }, () => jwt)).toThrow('handoff_report_required');
      expect(armedAutoClosePaneId('jwt-only')).toBe('pane-jwt');
    } finally { disarmAutoCloseOnHandoff('jwt-only', 'pane-jwt'); }
  });
  it('does not close on a redaction marker when the terminal contained only a private key', () => {
    armAutoCloseOnHandoff('private-only', 'pane-private');
    try {
      expect(() => assertAutoCloseReportPreserved('private-only', 'pane-private', 'success', {
        summary: 'Pesquisa concluída, veja os detalhes.',
        fullText: 'Pesquisa concluída, veja os detalhes.',
      }, () => '-----BEGIN PRIVATE KEY-----\nprivate fixture bytes\n-----END PRIVATE KEY-----'))
        .toThrow('handoff_report_required');
      expect(armedAutoClosePaneId('private-only')).toBe('pane-private');
    } finally { disarmAutoCloseOnHandoff('private-only', 'pane-private'); }
  });
  it('preserves a long summary through the existing full-summary condensation contract', () => {
    armAutoCloseOnHandoff('long-report', 'pane-report');
    const read = vi.fn(() => '');
    try {
      expect(assertAutoCloseReportPreserved('long-report', 'pane-report', 'success', {
        summary: 'Relatório completo com os resultados e referências. '.repeat(12),
      }, read)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    } finally { disarmAutoCloseOnHandoff('long-report', 'pane-report'); }
  });
  it('accepts complete reports in the existing native artifact format and rejects truncation', () => {
    armAutoCloseOnHandoff('report-format', 'pane-report');
    try {
      expect(() => assertAutoCloseReportPreserved('report-format', 'pane-report', 'success', {
        summary: 'Resumo curto', artifacts: [{ fullText: 'Relatório completo do worker.' }],
      })).not.toThrow();
      expect(() => assertAutoCloseReportPreserved('report-format', 'pane-report', 'success', {
        fullText: 'x'.repeat(60_001),
      })).toThrow('handoff_report_required');
    } finally { disarmAutoCloseOnHandoff('report-format', 'pane-report'); }
  });
  it("não fecha a sessão substituta quando o pane muda antes do callback", async () => {
    vi.useFakeTimers();
    try {
      let currentSession = "sess-original";
      const close = vi.fn(async (_paneId: string, _expectedSessionId: string) => true);
      armAutoCloseOnHandoff("sess-original", "pane-reused");

      scheduleAutoCloseAfterHandoff(
        "sess-original",
        "success",
        (sessionId) => sessionId === currentSession ? "pane-reused" : null,
        close,
      );
      currentSession = "sess-replacement";
      await vi.runAllTimersAsync();

      expect(close).not.toHaveBeenCalled();
      expect(armedAutoClosePaneId("sess-original")).toBeNull();
    } finally {
      disarmAutoCloseOnHandoff("sess-original", "pane-reused");
      vi.useRealTimers();
    }
  });
});

// Paridade Overclock: autoCloseOnHandoff declarado no NASCIMENTO do pane
// (record-not-ask). Fecha SÓ no handoff success — falha preserva o pane e o
// scrollback para diagnóstico (doutrina de sobrevivência).
describe("shouldAutoCloseAfterHandoff", () => {
  it("fecha no success quando armado", () => {
    expect(
      shouldAutoCloseAfterHandoff({ armed: true, status: "success" }),
    ).toBe(true);
  });
  it("preserva o pane em partial/blocked/failed", () => {
    for (const status of ["partial", "blocked", "failed"]) {
      expect(shouldAutoCloseAfterHandoff({ armed: true, status })).toBe(false);
    }
  });
  it("nunca fecha sem o braço do spawn", () => {
    expect(
      shouldAutoCloseAfterHandoff({ armed: false, status: "success" }),
    ).toBe(false);
  });
});

// Motor (06/10): quem nasce com o braço armado. Worker de missão fecha após
// entregar a peça — nada de RAM parada. Orquestrador e a mão do operador
// dentro da missão (F-231) nunca entram.
describe("shouldArmAutoCloseOnHandoff", () => {
  const base = {
    explicit: undefined,
    operatorHand: false,
    missionId: undefined,
    role: undefined,
    operatorOpened: undefined,
  };

  it("helper da mão do operador sem missão arma por padrão (C3)", () => {
    expect(
      shouldArmAutoCloseOnHandoff({ ...base, operatorHand: true }),
    ).toBe(true);
  });

  it("worker de missão arma por padrão (motor: peça terminou, fecha)", () => {
    expect(
      shouldArmAutoCloseOnHandoff({
        ...base,
        missionId: "m1",
        role: "worker",
      }),
    ).toBe(true);
  });

  it("orquestrador nunca arma", () => {
    expect(
      shouldArmAutoCloseOnHandoff({
        ...base,
        missionId: "m1",
        role: "orchestrator",
      }),
    ).toBe(false);
  });

  it("mão do operador dentro da missão (operatorOpened) nunca arma", () => {
    expect(
      shouldArmAutoCloseOnHandoff({
        ...base,
        missionId: "m1",
        role: "worker",
        operatorOpened: true,
      }),
    ).toBe(false);
  });

  it("autoCloseOnHandoff: false explícito vence sempre", () => {
    expect(
      shouldArmAutoCloseOnHandoff({ ...base, explicit: false, operatorHand: true }),
    ).toBe(false);
    expect(
      shouldArmAutoCloseOnHandoff({
        ...base,
        explicit: false,
        missionId: "m1",
        role: "worker",
      }),
    ).toBe(false);
  });

  it("autoCloseOnHandoff: true força para qualquer um", () => {
    expect(
      shouldArmAutoCloseOnHandoff({
        ...base,
        explicit: true,
        missionId: "m1",
        role: "orchestrator",
      }),
    ).toBe(true);
    expect(
      shouldArmAutoCloseOnHandoff({
        ...base,
        explicit: true,
        missionId: "m1",
        role: "worker",
        operatorOpened: true,
      }),
    ).toBe(true);
  });

  it("helper sem missão e sem role (filho ad-hoc) também arma", () => {
    expect(shouldArmAutoCloseOnHandoff({ ...base, operatorHand: true })).toBe(
      true,
    );
    // Sem operador, sem missão, sem role: nasce helper puro — não arma
    // (só o braço explícito ou a mão do operador).
    expect(shouldArmAutoCloseOnHandoff({ ...base })).toBe(false);
  });
});

describe("braço de autoClose por pane (spawn com ACK pendente)", () => {
  it("armado pelo pane antes de a sessão existir, o handoff da sessão desse pane acha o braço", () => {
    armAutoCloseOnHandoffForPane("pane-pending");
    expect(armedAutoClosePaneId("sess-late", "pane-pending")).toBe("pane-pending");
    expect(armedAutoClosePaneId("sess-late", "pane-other")).toBeNull();
    expect(armedAutoClosePaneId("sess-late")).toBeNull();
    disarmAutoCloseOnHandoff("sess-late", "pane-pending");
    expect(armedAutoClosePaneId("sess-late", "pane-pending")).toBeNull();
  });

  it("o braço por sessão continua valendo sem paneId", () => {
    armAutoCloseOnHandoff("sess-a", "pane-a");
    expect(armedAutoClosePaneId("sess-a")).toBe("pane-a");
    disarmAutoCloseOnHandoff("sess-a");
    expect(armedAutoClosePaneId("sess-a")).toBeNull();
  });
});

// F-1634 (revisão do Codex no PR 159): quem pode receber rework é quem
// ESCREVE. O rótulo `readOnly` é consultivo fora do Hardened (F-1157) e
// `isolatedWriter: true` explícito vence esse rótulo (F-1318): o "leitor" que
// pediu worktree é writer. Ler só o rótulo tirava o writer isolado da espera
// pelo aceite, e o rework dele voltava a cair em resume/pane novo.
describe("missionWriterAwaitsHandoffAck", () => {
  const worker = { missionId: "m1", role: "worker" as const };

  it("writer comum de missão espera o aceite", () => {
    expect(missionWriterAwaitsHandoffAck(worker)).toBe(true);
  });

  it("writer isolado rotulado readOnly continua writer (F-1318)", () => {
    expect(missionWriterAwaitsHandoffAck({ ...worker, readOnly: true, isolatedWriter: true })).toBe(true);
  });

  it("revisor somente leitura não espera: não existe rework de leitura", () => {
    expect(missionWriterAwaitsHandoffAck({ ...worker, readOnly: true })).toBe(false);
  });

  it("lane confinada pelo Hardened nunca escreve, nem pedindo worktree (F-1157)", () => {
    expect(missionWriterAwaitsHandoffAck({ ...worker, readOnlyEnforced: true, isolatedWriter: true })).toBe(false);
  });

  it("fora de missão e fora do papel de worker não espera (não há ACK)", () => {
    expect(missionWriterAwaitsHandoffAck({ role: "worker" })).toBe(false);
    expect(missionWriterAwaitsHandoffAck({ missionId: "m1", role: "orchestrator" })).toBe(false);
  });
});

// F-1409: o operador fechava à mão os workers que entregaram partial e ficaram
// parados. Não-success de worker armado fecha no ACK aceito do Maestro ou,
// sem ACK, depois de NON_SUCCESS_IDLE_CLOSE_MS com o worker parado.
describe("F-1409: entrega não-success fecha no ACK ou na rede de segurança", () => {
  const paneOf = (sessionId: string) => sessionId === "sess-w" ? "pane-w" : null;
  function deliver(status: string, opts: { arm?: boolean; busy?: () => boolean } = {}) {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    if (opts.arm !== false) armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", status, paneOf, close, {
      handoffId: "hoff-1", isBusy: opts.busy,
    });
    return close;
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    disarmAutoCloseOnHandoff("sess-w", "pane-w");
    vi.useRealTimers();
  });

  it.each(["partial", "failed", "blocked"])("%s fica aberto até o ACK aceito e então fecha", async (status) => {
    const close = deliver(status);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(close).not.toHaveBeenCalled();

    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-1", "accepted")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledWith("pane-w", "sess-w");
    expect(armedAutoClosePaneId("sess-w")).toBeNull();
  });

  it("ACK rework mantém o pane aberto (recebe a nota) e cancela a rede de segurança", async () => {
    const close = deliver("partial");
    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-1", "rework")).toBe(false);
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    expect(armedAutoClosePaneId("sess-w")).toBe("pane-w");
  });

  it("ACK de outro handoff não fecha", async () => {
    const close = deliver("partial");
    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-outro", "accepted")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).not.toHaveBeenCalled();
  });

  it("sem ACK: fecha depois de 15 min com o worker parado; ocupado adia", async () => {
    let busy = true;
    const close = deliver("blocked", { busy: () => busy });
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).not.toHaveBeenCalled(); // ocupado: adiou
    busy = false;
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS + 1);
    expect(close).toHaveBeenCalledWith("pane-w", "sess-w");
  });

  it("sem braço (autoCloseOnHandoff:false / pane do operador) nunca fecha", async () => {
    const close = deliver("partial", { arm: false });
    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-1", "accepted")).toBe(false);
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
  });

  it("success posterior fecha já e descarta a pendência", async () => {
    const close = deliver("partial");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, { handoffId: "hoff-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-1", "accepted")).toBe(false);
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS * 2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // F-1634: a entrega `success` do worker de missão ainda passa pelo veredito
  // do Maestro. Fechar o pane no submit apagava o contexto antes dele: um
  // `rework` depois caía numa encarnação nova (resume indisponível => brief
  // original) e o worker refazia o trabalho do zero — o "recusa isso, aí
  // volta tudo de novo" que o operador vê. Com o aceite pendente, `accepted`
  // fecha na hora e `rework` chega ao pane morno, que já sabe o que tentou.
  it("success de worker de missão espera o aceite em vez de fechar no submit", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, {
      handoffId: "hoff-ack", awaitAckOnSuccess: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(close).not.toHaveBeenCalled();

    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-ack", "accepted")).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledWith("pane-w", "sess-w");
  });

  it("rework de um success pendente mantém o pane morno para a nota", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, {
      handoffId: "hoff-ack", awaitAckOnSuccess: true,
    });
    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-ack", "rework")).toBe(false);
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    expect(armedAutoClosePaneId("sess-w")).toBe("pane-w");
  });

  it("Maestro que nunca acusa não deixa o worker aberto: a rede fecha no prazo do aceite", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, {
      handoffId: "hoff-ack", awaitAckOnSuccess: true,
    });
    await vi.advanceTimersByTimeAsync(SUCCESS_ACK_IDLE_CLOSE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(close).toHaveBeenCalledWith("pane-w", "sess-w");
  });

  // F-1634: o `success` esperava o aceite, mas o prazo só começa quando a
  // entrega sai de `queued` (M3) — então uma entrega presa deixava o pane de
  // ~1 GB vivo sem prazo nenhum. Antes da mudança o `success` fechava na hora,
  // e o `success` é o caso COMUM: o teto é obrigatório aqui.
  it("entrega presa em queued não deixa o worker aberto para sempre", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, {
      handoffId: "hoff-stuck",
      awaitAckOnSuccess: true,
      isDelivered: () => false,
    });
    await vi.advanceTimersByTimeAsync(SUCCESS_ACK_DELIVERY_CEILING_MS + SUCCESS_ACK_IDLE_CLOSE_MS + 1_000);
    expect(close).toHaveBeenCalledWith("pane-w", "sess-w");
  });

  // F-1634 (revisão do Codex no PR 159): um worker pode ter DUAS rodadas
  // entregues e não consumidas — payload novo depois de uma entrega já
  // entregue abre rodada nova (F-239). O ramo de `rework` limpava a espera da
  // sessão SEM conferir o handoff, então um ACK da rodada ANTIGA cancelava a
  // rede de segurança da rodada NOVA e o pane ficava armado sem prazo. O
  // defeito é anterior a esta mudança, mas ela o leva ao caso comum: antes só
  // partial/failed/blocked criavam espera, agora o `success` também.
  it("rework de uma rodada antiga não cancela a rede de segurança da nova", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, {
      handoffId: "rodada-1", awaitAckOnSuccess: true,
    });
    // Rodada nova do mesmo worker, antes de o Maestro consumir a primeira.
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, {
      handoffId: "rodada-2", awaitAckOnSuccess: true,
    });

    // O Maestro devolve a rodada ANTIGA.
    expect(closeAfterNonSuccessHandoffAck("sess-w", "rodada-1", "rework")).toBe(false);

    // A rede da rodada 2 sobrevive: o pane não fica armado para sempre.
    await vi.advanceTimersByTimeAsync(SUCCESS_ACK_IDLE_CLOSE_MS + 1_000);
    expect(close).toHaveBeenCalledWith("pane-w", "sess-w");
  });

  it("rework da rodada em espera continua cancelando a rede dela", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, {
      handoffId: "rodada-1", awaitAckOnSuccess: true,
    });
    expect(closeAfterNonSuccessHandoffAck("sess-w", "rodada-1", "rework")).toBe(false);
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    expect(armedAutoClosePaneId("sess-w")).toBe("pane-w");
  });

  it("sem awaitAckOnSuccess (helper do operador, sem missão) success fecha já", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-w", "pane-w");
    scheduleAutoCloseAfterHandoff("sess-w", "success", paneOf, close, { handoffId: "hoff-now" });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledWith("pane-w", "sess-w");
  });

  it.each(["progress", "stalled"])("%s nunca arma a rede de 15 min (só partial|failed|blocked)", async (status) => {
    const close = deliver(status);
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    expect(closeAfterNonSuccessHandoffAck("sess-w", "hoff-1", "accepted")).toBe(false);
    expect(armedAutoClosePaneId("sess-w")).toBe("pane-w");
  });
});

// F-1409/M3 (revisão Fable): Maestro em turno longo deixa o partial `queued`;
// contar do submit fechava o worker antes de o Maestro ler e pedir rework.
describe("F-1409/M3: os 15 min contam da chegada ao Maestro, não do submit", () => {
  const paneOf = (sessionId: string) => sessionId === "sess-q" ? "pane-q" : null;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    disarmAutoCloseOnHandoff("sess-q", "pane-q");
    vi.useRealTimers();
  });

  it("entrega queued por 40 min não fecha; fecha 15 min depois de chegar ao Maestro", async () => {
    let delivered = false;
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-q", "pane-q");
    scheduleAutoCloseAfterHandoff("sess-q", "partial", paneOf, close, {
      handoffId: "hoff-q", isBusy: () => false, isDelivered: () => delivered,
    });

    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(close).not.toHaveBeenCalled();

    delivered = true; // idle-delivery colou: deliveryState saiu de queued
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS - 2 * 60_000);
    expect(close).not.toHaveBeenCalled();
    // Rework ainda alcança o pane vivo dentro da janela.
    expect(armedAutoClosePaneId("sess-q")).toBe("pane-q");

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(close).toHaveBeenCalledWith("pane-q", "sess-q");
  });
});

describe("F-1409 (revisão Grok): rework vence o close agendado; one-shot por saída nova", () => {
  const paneOf = (sessionId: string) => sessionId === "sess-g" ? "pane-g" : null;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    disarmAutoCloseOnHandoff("sess-g", "pane-g");
    vi.useRealTimers();
  });

  it("#1 rework entre o desarme do timer e o setTimeout(0) do close cancela o fechamento", async () => {
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-g", "pane-g");
    scheduleAutoCloseAfterHandoff("sess-g", "partial", paneOf, close, {
      handoffId: "hoff-g", isBusy: () => false, isDelivered: () => true,
    });
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS - 1);
    // Fase 1: só o timer da rede de segurança dispara — desarma e agenda o close.
    vi.advanceTimersToNextTimer();
    expect(armedAutoClosePaneId("sess-g")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    // Rework chega antes da fase 2 (o setTimeout 0).
    expect(closeAfterNonSuccessHandoffAck("sess-g", "hoff-g", "rework")).toBe(false);
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    // Braço volta: a próxima entrega do writer ainda fecha o pane.
    expect(armedAutoClosePaneId("sess-g")).toBe("pane-g");
  });

  it("#2 one-shot (isBusy falso, só saída): saída nova na janela adia; sem saída fecha", async () => {
    let output = 10;
    const close = vi.fn(async (_paneId: string, _sessionId: string) => true);
    armAutoCloseOnHandoff("sess-g", "pane-g");
    scheduleAutoCloseAfterHandoff("sess-g", "partial", paneOf, close, {
      handoffId: "hoff-g", isBusy: () => false, isDelivered: () => true,
      activityMark: () => output,
    });
    output += 3; // o processo one-shot ainda escreve depois da entrega
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS + 1);
    expect(close).not.toHaveBeenCalled();
    // Nova janela sem saída nenhuma: fecha (não reagenda para sempre).
    await vi.advanceTimersByTimeAsync(NON_SUCCESS_IDLE_CLOSE_MS + 1);
    expect(close).toHaveBeenCalledWith("pane-g", "sess-g");
  });
});
