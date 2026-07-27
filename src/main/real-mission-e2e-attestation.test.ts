import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseRealMissionE2EEvidence,
  type RealMissionE2EEvidence,
} from "../shared/real-mission-e2e";
import { validPassEvidence } from "../shared/real-mission-e2e-test-support";
import { canonicalJson } from "./context/canonical-json";
import { createRealMissionEvidenceAttester } from "./real-mission-e2e-attestation";
// @ts-expect-error Test-only MJS verifier intentionally has no production TS surface.
import { verifyRuntimeAttestationTestCore } from "../../scripts/e2e-real-mission-runtime.mjs";

const appVersion = "0.19.27";
const binding = {
  version: 1 as const,
  bundleId: "com.nexuside.app" as const,
  launchSurface: "product-wizard" as const,
  appVersion,
  commitSha: "a".repeat(40),
  artifact: {
    sha256: "b".repeat(64),
    identity:
      "Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)",
  },
};

function fixture() {
  const secret = randomBytes(32);
  const challenge = randomBytes(32);
  const environment: NodeJS.ProcessEnv = {
    NEXUS_REAL_MISSION_ATTESTATION_SECRET: secret.toString("base64url"),
    NEXUS_REAL_MISSION_ATTESTATION_CHALLENGE:
      challenge.toString("base64url"),
    NEXUS_REAL_MISSION_ATTESTATION_BINDING: Buffer.from(
      canonicalJson(binding),
      "utf8",
    ).toString("base64url"),
  };
  const unsigned = parseRealMissionE2EEvidence(
    validPassEvidence("product-wizard"),
  );
  const attest = createRealMissionEvidenceAttester({
    environment,
    appVersion,
    launchSurface: "product-wizard",
  });
  return { secret, challenge, environment, unsigned, attest };
}

describe("real mission outer-runner runtime attestation", () => {
  it("matches the independent MJS verifier and consumes all secret env", () => {
    const { secret, challenge, environment, unsigned, attest } = fixture();
    const signed = attest(unsigned);

    expect(environment).toEqual({});
    expect(signed.runtimeAttestation).toMatchObject({
      version: 1,
      algorithm: "hmac-sha256",
    });
    expect(() =>
      verifyRuntimeAttestationTestCore(signed, {
        secret,
        challenge,
        binding,
      }),
    ).not.toThrow();
  });

  it("rejects evidence tamper, MAC tamper and cross-run replay", () => {
    const { secret, challenge, unsigned, attest } = fixture();
    const signed = attest(unsigned);
    const attacks: Array<{
      evidence: RealMissionE2EEvidence;
      challenge: Buffer;
    }> = [
      {
        evidence: { ...signed, appVersion: "0.19.28" },
        challenge,
      },
      {
        evidence: {
          ...signed,
          runtimeAttestation: {
            ...signed.runtimeAttestation!,
            macSha256: "0".repeat(64),
          },
        },
        challenge,
      },
      {
        evidence: signed,
        challenge: randomBytes(32),
      },
    ];
    for (const attack of attacks) {
      expect(() =>
        verifyRuntimeAttestationTestCore(attack.evidence, {
          secret,
          challenge: attack.challenge,
          binding,
        }),
      ).toThrow(/attestation/i);
    }
  });

  it("strict-parses the unsigned v8 envelope before signing", () => {
    const { unsigned, attest } = fixture();
    expect(() =>
      attest({
        ...unsigned,
        injectedAuthority: true,
      } as RealMissionE2EEvidence),
    ).toThrow();
    const missingRunId = { ...unsigned } as Partial<RealMissionE2EEvidence>;
    delete missingRunId.runId;
    expect(() => attest(missingRunId as RealMissionE2EEvidence)).toThrow();
  });
});
