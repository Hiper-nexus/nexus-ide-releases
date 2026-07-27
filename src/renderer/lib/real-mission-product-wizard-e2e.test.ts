// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_MESSAGE,
  REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_RESULT_MESSAGE,
} from "../../shared/real-mission-e2e";
import { recordRealMissionProductWizardStep } from "./real-mission-product-wizard-e2e";

const requests: Array<{
  missionId: string;
  requestId: string;
  step: string;
}> = [];
let responseOk = true;

function emulatePreload(event: MessageEvent<unknown>): void {
  if (event.source !== window) return;
  const raw = event.data;
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { type?: unknown }).type !==
      REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_MESSAGE
  ) {
    return;
  }
  const request = raw as {
    missionId: string;
    requestId: string;
    step: string;
  };
  requests.push(request);
  window.postMessage(
    {
      type: REAL_MISSION_E2E_PRODUCT_WIZARD_STEP_RESULT_MESSAGE,
      requestId: request.requestId,
      ok: responseOk,
    },
    "*",
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  requests.length = 0;
  responseOk = true;
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        source: window,
      }),
    );
  });
  window.addEventListener("message", emulatePreload);
});

afterEach(() => {
  window.removeEventListener("message", emulatePreload);
  vi.restoreAllMocks();
});

describe("product wizard release-only causal bridge", () => {
  it("delegates inactivity authority to preload instead of sessionStorage", async () => {
    await expect(
      recordRealMissionProductWizardStep("mission-armed", "mission-a"),
    ).resolves.toBeUndefined();
    expect(requests).toMatchObject([
      { missionId: "mission-a", step: "mission-armed" },
    ]);
  });

  it("round-trips the exact mission and each bounded step through main", async () => {
    for (const step of [
      "mission-armed",
      "intent-submitted",
      "approval-returned",
    ] as const) {
      await expect(
        recordRealMissionProductWizardStep(step, "mission-product"),
      ).resolves.toBeUndefined();
    }

    expect(requests.map(({ missionId, step }) => ({ missionId, step }))).toEqual(
      [
        { missionId: "mission-product", step: "mission-armed" },
        { missionId: "mission-product", step: "intent-submitted" },
        { missionId: "mission-product", step: "approval-returned" },
      ],
    );
  });

  it("halts the wizard when main does not acknowledge a causal step", async () => {
    responseOk = false;

    await expect(
      recordRealMissionProductWizardStep("intent-submitted", "mission-a"),
    ).rejects.toThrow(/main rejected/i);
  });

  it("is awaited by the real MissionWizard at all three authority edges", () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "src/renderer/components/MissionWizard.tsx",
      ),
      "utf8",
    );
    const positions = [
      '"mission-armed"',
      '"intent-submitted"',
      '"approval-returned"',
    ].map((marker) => source.indexOf(marker));

    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(source.match(/await recordRealMissionProductWizardStep/gu)).toHaveLength(
      3,
    );
  });

  it("marks the sole launch edge for preload trusted-event capture", () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "src/renderer/components/MissionWizardReview.tsx",
      ),
      "utf8",
    );
    expect(
      source.match(/data-nexus-real-mission-wizard-launch="true"/gu),
    ).toHaveLength(1);
  });
});
