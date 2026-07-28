import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const e2eFlag = vi.hoisted(() => ({ value: false }));
const userDataDir = vi.hoisted(() => ({ value: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "userData") throw new Error(`unexpected path ${name}`);
      return userDataDir.value;
    },
  },
}));

vi.mock("../../shared/real-mission-e2e", () => ({
  isCurrentProcessRealMissionE2E: () => e2eFlag.value,
}));

import {
  clearMissionApprovalTrustForTests,
  hasMissionApprovalTrust,
  missionApprovalTrustKeyFrom,
  rememberMissionApprovalTrust,
} from "./mission-approval-trust";

describe("mission-approval-trust", () => {
  beforeEach(() => {
    e2eFlag.value = false;
    userDataDir.value = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-approval-trust-"),
    );
  });

  afterEach(() => {
    clearMissionApprovalTrustForTests();
    fs.rmSync(userDataDir.value, { recursive: true, force: true });
  });

  it("remembers and matches the exact project+roster hash", () => {
    const key = missionApprovalTrustKeyFrom(
      {
        installationId: "install-1",
        projectId: "project-1",
        checkoutId: "checkout-1",
      },
      "a".repeat(64),
    );
    expect(hasMissionApprovalTrust(key)).toBe(false);
    rememberMissionApprovalTrust(key, "squad-source");
    expect(hasMissionApprovalTrust(key)).toBe(true);
    expect(
      hasMissionApprovalTrust({
        ...key,
        squadRevisionHash: "b".repeat(64),
      }),
    ).toBe(false);
  });

  it("stays disabled during the real-mission E2E gate", () => {
    e2eFlag.value = true;
    const key = missionApprovalTrustKeyFrom(
      {
        installationId: "install-1",
        projectId: "project-1",
        checkoutId: "checkout-1",
      },
      "c".repeat(64),
    );
    rememberMissionApprovalTrust(key);
    expect(hasMissionApprovalTrust(key)).toBe(false);
  });
});
