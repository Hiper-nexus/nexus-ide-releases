/**
 * Fechamento de panes por ESCOPO explícito + autoCloseOnHandoff (paridade
 * Overclock, gap e). Doutrina: o chamador NOMEIA o que fecha — nada implícito;
 * o desligamento automático é declarado no nascimento do pane (registro, não
 * pergunta) e só dispara no handoff success — falha preserva pane e scrollback
 * para diagnóstico.
 */

export interface ScopedCloseCandidate {
  readonly paneId: string;
  readonly sessionId?: string;
  readonly missionId?: string;
  readonly role?: "orchestrator" | "worker";
  readonly scopeRoot?: string;
}

export interface ScopedCloseSelection {
  readonly close: readonly string[];
  readonly skipped: readonly { paneId: string; reason: string }[];
}

export function selectScopedPaneCloseTargets(input: {
  readonly scope: "caller_mission" | "caller_workspace";
  readonly callerSessionId?: string;
  readonly callerMissionId?: string;
  readonly callerScopeRoot: string;
  readonly panes: readonly ScopedCloseCandidate[];
  readonly isMissionRunning: (missionId: string) => boolean;
}): ScopedCloseSelection {
  const close: string[] = [];
  const skipped: { paneId: string; reason: string }[] = [];
  for (const pane of input.panes) {
    const inScope =
      input.scope === "caller_mission"
        ? Boolean(input.callerMissionId) &&
          pane.missionId === input.callerMissionId
        : pane.scopeRoot === input.callerScopeRoot;
    if (!inScope) continue;
    if (pane.sessionId && pane.sessionId === input.callerSessionId) {
      skipped.push({ paneId: pane.paneId, reason: "caller" });
      continue;
    }
    if (pane.role === "orchestrator") {
      skipped.push({ paneId: pane.paneId, reason: "orchestrator" });
      continue;
    }
    // Worker de OUTRA missão em execução: a autoridade é do scheduler dela —
    // só o escopo da PRÓPRIA missão do chamador pode derrubar workers vivos.
    if (
      input.scope === "caller_workspace" &&
      pane.missionId &&
      pane.missionId !== input.callerMissionId &&
      input.isMissionRunning(pane.missionId)
    ) {
      skipped.push({ paneId: pane.paneId, reason: "mission-running" });
      continue;
    }
    close.push(pane.paneId);
  }
  return Object.freeze({
    close: Object.freeze(close),
    skipped: Object.freeze(skipped),
  });
}

export function shouldAutoCloseAfterHandoff(input: {
  readonly armed: boolean;
  readonly status: string;
}): boolean {
  return input.armed && input.status === "success";
}

/**
 * Braços de autoCloseOnHandoff por sessão física. Registro em memória: o
 * braço morre com o processo — um pane sobrevivente de crash nunca fecha
 * sozinho por um braço fantasma.
 */
const armedBySession = new Map<string, string>();

export function armAutoCloseOnHandoff(
  sessionId: string,
  paneId: string,
): void {
  armedBySession.set(sessionId, paneId);
}

export function disarmAutoCloseOnHandoff(sessionId: string): void {
  armedBySession.delete(sessionId);
}

export function armedAutoClosePaneId(sessionId: string): string | null {
  return armedBySession.get(sessionId) ?? null;
}
