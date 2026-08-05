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
  missionApprovalTrustRevisionHash,
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

  it("honra o selo derivado: a cópia de runtime herda a confiança da origem", () => {
    // O approve SELA o squad numa cópia imutável `mission-runtime-*` e rebinda
    // a missão nela (renderer-mission-authority: sealMissionSquadForApproval).
    // Como o hash do snapshot inclui o id, o próximo candidato da MESMA missão
    // traz outro hash — e o "não perguntar de novo" que o operador acabou de
    // marcar seria ignorado no clique seguinte. A identidade de confiança é a
    // revisão de ORIGEM, que é exatamente o roster revisado.
    const sourceHash = "a".repeat(64);
    const scope = {
      installationId: "install-1",
      projectId: "project-1",
      checkoutId: "checkout-1",
    };
    const beforeSeal = missionApprovalTrustKeyFrom(
      scope,
      missionApprovalTrustRevisionHash({ hash: sourceHash }),
    );
    rememberMissionApprovalTrust(beforeSeal, "saved-squad");

    const afterSeal = missionApprovalTrustKeyFrom(
      scope,
      missionApprovalTrustRevisionHash({
        hash: "d".repeat(64),
        runtimeSourceSquadId: "saved-squad",
        runtimeSourceSquadRevisionHash: sourceHash,
      }),
    );
    expect(hasMissionApprovalTrust(afterSeal)).toBe(true);
  });

  it("não estende confiança a uma origem diferente", () => {
    const scope = {
      installationId: "install-1",
      projectId: "project-1",
      checkoutId: "checkout-1",
    };
    rememberMissionApprovalTrust(
      missionApprovalTrustKeyFrom(
        scope,
        missionApprovalTrustRevisionHash({ hash: "a".repeat(64) }),
      ),
    );
    expect(
      hasMissionApprovalTrust(
        missionApprovalTrustKeyFrom(
          scope,
          missionApprovalTrustRevisionHash({
            hash: "d".repeat(64),
            runtimeSourceSquadId: "outro-squad",
            runtimeSourceSquadRevisionHash: "b".repeat(64),
          }),
        ),
      ),
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
