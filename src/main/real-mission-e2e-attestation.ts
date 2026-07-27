import { createHash, createHmac } from "node:crypto";

import { z } from "zod";

import {
  REAL_MISSION_E2E_BUNDLE_ID,
  parseRealMissionE2EEvidence,
  realMissionRuntimeAttestationSchema,
  type RealMissionE2EEvidence,
  type RealMissionE2ELaunchSurface,
} from "../shared/real-mission-e2e";
import { canonicalJson } from "./context/canonical-json";

const SECRET_ENV = "NEXUS_REAL_MISSION_ATTESTATION_SECRET";
const CHALLENGE_ENV = "NEXUS_REAL_MISSION_ATTESTATION_CHALLENGE";
const BINDING_ENV = "NEXUS_REAL_MISSION_ATTESTATION_BINDING";
const DOMAIN = "nexus-real-mission-runtime-attestation-v1";

const releaseBindingSchema = z
  .object({
    version: z.literal(1),
    bundleId: z.literal(REAL_MISSION_E2E_BUNDLE_ID),
    launchSurface: z.enum(["private-runner", "product-wizard"]),
    appVersion: z.string().min(1).max(64),
    commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    artifact: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        identity: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeSecret(value: string | undefined, label: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`real mission ${label} is missing or malformed`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32) {
    throw new Error(`real mission ${label} must contain 32 bytes`);
  }
  return decoded;
}

function decodeBinding(value: string | undefined): unknown {
  if (!value || !/^[A-Za-z0-9_-]{16,8192}$/u.test(value)) {
    throw new Error("real mission release binding is missing or malformed");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength > 6_144) {
    throw new Error("real mission release binding is too large");
  }
  return JSON.parse(decoded.toString("utf8")) as unknown;
}

export type RealMissionEvidenceAttester = (
  evidence: RealMissionE2EEvidence,
) => RealMissionE2EEvidence;

/**
 * The outer release runner owns the ephemeral secret. Main signs the exact
 * live evidence envelope; renderer/preload never receive the secret and the
 * persisted artifact carries only hashes plus the MAC.
 */
export function createRealMissionEvidenceAttester(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly appVersion: string;
  readonly launchSurface: RealMissionE2ELaunchSurface;
}): RealMissionEvidenceAttester {
  const encodedSecret = input.environment[SECRET_ENV];
  const encodedChallenge = input.environment[CHALLENGE_ENV];
  const encodedBinding = input.environment[BINDING_ENV];
  // Consume before any provider/PTY can inherit main's environment.
  delete input.environment[SECRET_ENV];
  delete input.environment[CHALLENGE_ENV];
  delete input.environment[BINDING_ENV];
  const secret = decodeSecret(encodedSecret, "attestation secret");
  const challenge = decodeSecret(
    encodedChallenge,
    "attestation challenge",
  );
  const binding = releaseBindingSchema.parse(
    decodeBinding(encodedBinding),
  );
  if (
    binding.appVersion !== input.appVersion ||
    binding.launchSurface !== input.launchSurface
  ) {
    throw new Error(
      "real mission release binding does not match the packaged runtime",
    );
  }
  const bindingSha256 = sha256(canonicalJson(binding));
  const challengeSha256 = sha256(challenge);

  return (evidence) => {
    const unsigned = parseRealMissionE2EEvidence({
      ...evidence,
      runtimeAttestation: null,
    });
    if (
      unsigned.appVersion !== binding.appVersion ||
      unsigned.launchSurface !== binding.launchSurface
    ) {
      throw new Error("real mission evidence diverges from release binding");
    }
    const evidenceSha256 = sha256(canonicalJson(unsigned));
    const message = canonicalJson({
      domain: DOMAIN,
      challenge: challenge.toString("base64url"),
      bindingSha256,
      evidenceSha256,
    });
    const runtimeAttestation = realMissionRuntimeAttestationSchema.parse({
      version: 1,
      algorithm: "hmac-sha256",
      challengeSha256,
      bindingSha256,
      evidenceSha256,
      macSha256: createHmac("sha256", secret).update(message).digest("hex"),
    });
    return parseRealMissionE2EEvidence({
      ...unsigned,
      runtimeAttestation,
    });
  };
}
