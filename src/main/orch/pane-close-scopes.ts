/**
 * Fechamento de panes por ESCOPO explícito + autoCloseOnHandoff (paridade
 * coordenação, gap e). Doutrina: o chamador NOMEIA o que fecha — nada implícito;
 * o desligamento automático é declarado no nascimento do pane (registro, não
 * pergunta) e só dispara no handoff success — falha preserva pane e scrollback
 * para diagnóstico.
*/
import { sanitizePaneBootOutput } from './pane-boot-output';

export interface ScopedCloseCandidate {
  readonly paneId: string;
  readonly sessionId?: string;
  readonly missionId?: string;
  readonly role?: "orchestrator" | "worker";
  /** F-231: mão do operador dentro da missão — o scope-close nunca a inclui. */
  readonly operatorOpened?: boolean;
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
    // F-231: "só ele fecha" — o scope-close do Maestro pula panes do operador.
    if (pane.operatorOpened === true) {
      skipped.push({ paneId: pane.paneId, reason: "operator-opened" });
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

/** A short notification alone must not destroy the pane's only complete report. */
export function assertAutoCloseReportPreserved(
  sessionId: string | undefined,
  paneId: string | null,
  status: unknown,
  args: { fullText?: unknown; summary?: unknown; artifacts?: unknown },
  readTerminalTail?: () => string,
): string | null {
  if (!sessionId || status !== 'success' || !armedAutoClosePaneId(sessionId, paneId)) return null;
  // Native system-delivery contract uses artifacts[].fullText; MCP also
  // accepts a top-level fullText. Both already persist verbatim in the ledger.
  const fullTextArtifact = Array.isArray(args.artifacts) ? args.artifacts.slice(0, 4096)
    .find(artifact => artifact && typeof artifact === 'object' &&
      (typeof artifact.fullText === 'string' || artifact.kind === 'overclock.fullText' && typeof artifact.payload === 'string')) : null;
  const report: string | null = typeof args.fullText === 'string' ? args.fullText : fullTextArtifact
    ? typeof fullTextArtifact.fullText === 'string' ? fullTextArtifact.fullText : fullTextArtifact.payload
    : typeof args.summary === 'string' && args.summary.trim().length > 400 ? args.summary.trim() : null;
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  // F-833/N4: naming the notification fullText does not preserve the report.
  // Capture only Main-owned output, never an agent-authored terminal artifact.
  const repeatedSummary = Boolean((typeof args.fullText === 'string' || fullTextArtifact) && report && summary && report.length <= 60_000 &&
    report.trim().length <= summary.length);
  if (!report?.trim() || repeatedSummary) {
    const tail = sanitizePaneBootOutput(readTerminalTail?.() ?? '');
    const useful = tail.split('\n').some(line => line.trim() &&
      !/^\[(?:sem saída capturada|\.\.\.[^\]\r\n]*|[^\]\r\n]*redigid[oa]s?|REDACTED)\]$/iu.test(line.trim()));
    if (useful && tail !== summary) return tail;
  }
  if (!report?.trim() || report.length > 60_000 || repeatedSummary) {
    throw new Error('handoff_report_required: este pane fecha após a entrega. Envie o relatório completo em fullText (até 60000 caracteres), além do summary. O pane foi preservado; nenhum sucesso foi registrado.');
  }
  return null;
}

/** Consome o braço apenas depois de um handoff persistido; fechar fica fora da resposta. */
export function scheduleAutoCloseAfterHandoff(
  sessionId: string | undefined,
  status: string,
  paneIdOf: (sessionId: string) => string | null,
  close: (paneId: string, expectedSessionId: string) => Promise<unknown>,
): void {
  if (!sessionId) return;
  const paneId = paneIdOf(sessionId);
  const armedPaneId = armedAutoClosePaneId(sessionId, paneId);
  if (!shouldAutoCloseAfterHandoff({ armed: armedPaneId !== null, status })) return;
  disarmAutoCloseOnHandoff(sessionId, paneId);
  setTimeout(() => {
    if (paneIdOf(sessionId) !== armedPaneId) return;
    void Promise.resolve().then(() => close(armedPaneId!, sessionId)).catch((error) =>
      console.warn(`[handoff] auto-close do pane ${armedPaneId} falhou:`, error),
    );
  }, 0);
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

/**
 * Braço por PANE para o spawn com ACK pendente: a mão do operador recebe o
 * paneId antes de a sessão existir, então não há sessão para armar ainda. O
 * handoff da sessão que nascer nesse pane encontra o braço pelo pane.
 */
const armedByPane = new Set<string>();

export function armAutoCloseOnHandoffForPane(paneId: string): void {
  armedByPane.add(paneId);
}

export function disarmAutoCloseOnHandoff(
  sessionId: string,
  paneId?: string | null,
): void {
  armedBySession.delete(sessionId);
  if (paneId) armedByPane.delete(paneId);
}

export function armedAutoClosePaneId(
  sessionId: string,
  paneId?: string | null,
): string | null {
  const bySession = armedBySession.get(sessionId);
  if (bySession) return bySession;
  return paneId && armedByPane.has(paneId) ? paneId : null;
}
