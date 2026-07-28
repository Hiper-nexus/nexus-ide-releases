import { dialog } from "electron";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

import type { RealMissionE2EEvidence } from "../shared/real-mission-e2e";
import { isCurrentProcessRealMissionE2E } from "../shared/real-mission-e2e";
import { stripAnsi } from "./orch/pane-registry";

export interface RealMissionInteractionCapture {
  nativeDialogCount: number;
  missionApprovalDialogCount: number;
  missionApprovalAcceptedCount: number;
}

export interface RealMissionApprovalDialogTiming {
  readonly openedAt: number | null;
  readonly acceptedAt: number | null;
}

export const realMissionInteractionCapture: RealMissionInteractionCapture = {
  nativeDialogCount: 0,
  missionApprovalDialogCount: 0,
  missionApprovalAcceptedCount: 0,
};
let realMissionDialogInstrumentationInstalled = false;
let realMissionApprovalDialogOpenedAt: number | null = null;
let realMissionApprovalDialogAcceptedAt: number | null = null;

export function resetRealMissionInteractionCapture(): void {
  realMissionInteractionCapture.nativeDialogCount = 0;
  realMissionInteractionCapture.missionApprovalDialogCount = 0;
  realMissionInteractionCapture.missionApprovalAcceptedCount = 0;
  realMissionApprovalDialogOpenedAt = null;
  realMissionApprovalDialogAcceptedAt = null;
}

export function readRealMissionApprovalDialogTiming(): RealMissionApprovalDialogTiming {
  return Object.freeze({
    openedAt: realMissionApprovalDialogOpenedAt,
    acceptedAt: realMissionApprovalDialogAcceptedAt,
  });
}

function messageBoxOptions(args: readonly unknown[]): MessageBoxOptions | null {
  const candidate = args.length === 1 ? args[0] : args[1];
  return candidate && typeof candidate === "object"
    ? (candidate as MessageBoxOptions)
    : null;
}

function isMissionApprovalDialog(options: MessageBoxOptions | null): boolean {
  return (
    options?.title === "Nexus IDE — iniciar missão" &&
    options.buttons?.length === 2 &&
    options.buttons[0] === "Negar" &&
    options.buttons[1]?.endsWith("iniciar") === true
  );
}

/**
 * Count every process-owned native message box during the isolated release
 * run. The wrapper records only bounded counters, never dialog text.
 */
export function installRealMissionDialogInstrumentation(): void {
  if (realMissionDialogInstrumentationInstalled) return;
  realMissionDialogInstrumentationInstalled = true;
  const mutableDialog = dialog as unknown as {
    showMessageBox: (...args: unknown[]) => Promise<MessageBoxReturnValue>;
    showMessageBoxSync: (...args: unknown[]) => number;
  };
  const originalAsync = mutableDialog.showMessageBox.bind(dialog);
  const originalSync = mutableDialog.showMessageBoxSync.bind(dialog);
  mutableDialog.showMessageBox = async (...args: unknown[]) => {
    const options = messageBoxOptions(args);
    const missionApproval = isMissionApprovalDialog(options);
    realMissionInteractionCapture.nativeDialogCount += 1;
    if (missionApproval) {
      realMissionInteractionCapture.missionApprovalDialogCount += 1;
      realMissionApprovalDialogOpenedAt = Date.now();
    }
    // Unattended product-wizard gate: keep the causal counters/timings, but do
    // not block forever waiting for a human to click the native sheet.
    if (missionApproval && isCurrentProcessRealMissionE2E()) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      realMissionInteractionCapture.missionApprovalAcceptedCount += 1;
      realMissionApprovalDialogAcceptedAt = Date.now();
      return { response: 1, checkboxChecked: false };
    }
    const result = await originalAsync(...args);
    if (missionApproval && result.response === 1) {
      realMissionInteractionCapture.missionApprovalAcceptedCount += 1;
      realMissionApprovalDialogAcceptedAt = Date.now();
    }
    return result;
  };
  mutableDialog.showMessageBoxSync = (...args: unknown[]) => {
    const options = messageBoxOptions(args);
    const missionApproval = isMissionApprovalDialog(options);
    realMissionInteractionCapture.nativeDialogCount += 1;
    if (missionApproval) {
      realMissionInteractionCapture.missionApprovalDialogCount += 1;
      realMissionApprovalDialogOpenedAt = Date.now();
    }
    if (missionApproval && isCurrentProcessRealMissionE2E()) {
      realMissionInteractionCapture.missionApprovalAcceptedCount += 1;
      realMissionApprovalDialogAcceptedAt = Date.now();
      return 1;
    }
    const response = originalSync(...args);
    if (missionApproval && response === 1) {
      realMissionInteractionCapture.missionApprovalAcceptedCount += 1;
      realMissionApprovalDialogAcceptedAt = Date.now();
    }
    return response;
  };
}

export function isCodexMcpApprovalPrompt(output: string): boolean {
  const normalized = stripAnsi(output)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
  const namesNexusTool = /\bnexus_[a-z0-9][a-z0-9_-]{1,127}\b/u.test(
    normalized,
  );
  const mcpContext =
    /\bmcp\b/u.test(normalized) ||
    /\b(?:tool|ferramenta|herramienta|outil|werkzeug)\b/u.test(normalized);
  const permissionLanguage =
    /\b(?:allow|approve|authorize|confirm|permission|permit|run the tool|permitir|aprovar|autorizar|confirmar|permissao|executar a ferramenta|ejecutar la herramienta|autoriser|confirmer)\b/u.test(
      normalized,
    );
  const explicitQuestion =
    /\bquestion\s+\d+\s*\/\s*\d+\b/u.test(normalized) ||
    /\b(?:allow for this session|remember this choice|cancel this tool call|enter to submit answer|esc to interrupt)\b/u.test(
      normalized,
    ) ||
    /\b(?:permitir nesta sessao|lembrar esta escolha|cancelar esta chamada|pressione enter|tecle enter|negar|cancelar)\b/u.test(
      normalized,
    ) ||
    /\?\s*(?:$|\d+\s*[\.\)])/u.test(normalized);
  return (
    namesNexusTool &&
    explicitQuestion &&
    // "Booting MCP server: nexus_* (… esc to interrupt)" is ordinary Codex
    // startup status, not an approval question. Requiring permission language
    // for status-only text preserves real localized MCP prompts while avoiding
    // a false release-gate abort before the server handshake reaches idle.
    permissionLanguage &&
    mcpContext
  );
}

export type FailureCode = NonNullable<
  RealMissionE2EEvidence["failure"]
>["code"];

export function createRealMissionPrematureExitHandlers(options: {
  readonly isSettled: () => boolean;
  readonly finish: (failureCode: FailureCode) => void;
}): {
  readonly beforeQuit: () => void;
  readonly ownerDestroyed: () => void;
  readonly rendererGone: () => void;
} {
  const close = (failureCode: FailureCode) => {
    if (!options.isSettled()) options.finish(failureCode);
  };
  return {
    beforeQuit: () => close("app-error"),
    ownerDestroyed: () => close("renderer-failed"),
    rendererGone: () => close("renderer-failed"),
  };
}
