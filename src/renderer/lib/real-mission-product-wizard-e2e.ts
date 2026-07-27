import {
  REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_MESSAGE,
  REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_RESULT_MESSAGE,
  type RealMissionE2EProductWizardStep,
} from "../../shared/real-mission-e2e";

/**
 * Renderer emits only a non-authoritative lifecycle hint. Preload may attach a
 * one-shot capability retained in its isolated world; main derives the actual
 * state and evidence. No capability or record IPC is exposed through
 * contextBridge.
 */
export async function recordRealMissionProductWizardStep(
  step: RealMissionE2EProductWizardStep,
  missionId: string,
): Promise<void> {
  const requestId = window.crypto.randomUUID();
  const result = await new Promise<{ ok: boolean; error?: string }>(
    (resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onResult);
        reject(new Error("preload did not acknowledge the product wizard step"));
      }, 30_000);
      function onResult(event: MessageEvent<unknown>): void {
        if (event.source !== window) return;
        const raw = event.data;
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          (raw as { type?: unknown }).type !==
            REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_RESULT_MESSAGE ||
          (raw as { requestId?: unknown }).requestId !== requestId
        ) {
          return;
        }
        window.clearTimeout(timeout);
        window.removeEventListener("message", onResult);
        const error =
          typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error.trim()
            : "";
        resolve({
          ok: (raw as { ok?: unknown }).ok === true,
          ...(error ? { error } : {}),
        });
      }
      window.addEventListener("message", onResult);
      window.postMessage(
        {
          type: REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_MESSAGE,
          requestId,
          missionId,
          step,
        },
        "*",
      );
    },
  );
  if (result.ok !== true) {
    throw new Error(
      result.error
        ? `main rejected the product wizard causal step: ${result.error}`
        : "main rejected the product wizard causal step",
    );
  }
}
