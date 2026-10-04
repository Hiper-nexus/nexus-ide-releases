import { describe, expect, it, vi } from "vitest";

import {
  armAutoCloseOnHandoff,
  assertAutoCloseReportPreserved,
  armAutoCloseOnHandoffForPane,
  armedAutoClosePaneId,
  disarmAutoCloseOnHandoff,
  selectScopedPaneCloseTargets,
  scheduleAutoCloseAfterHandoff,
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
