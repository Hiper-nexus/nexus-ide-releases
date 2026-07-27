import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  killProcessTree,
  resolvePackagedTarget,
} from "./smoke-packaged-app.mjs";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  REAL_MISSION_CHILD_PHASES,
  REAL_MISSION_CTA,
  REAL_MISSION_EVIDENCE_FILE,
  REAL_MISSION_TIMEOUT_MS,
  canonicalJson,
  record,
} from "./e2e-real-mission-contract.mjs";
import {
  assertCodexReady,
  realMissionArgs,
  realMissionEnvironment,
  resolveTrustedCodexBinary,
  stageCodexAuthentication,
  stageRealMissionOnboardingComplete,
  stageTrustedCodexLauncher,
} from "./e2e-real-mission-launcher.mjs";
import {
  assertRealMissionPassEvidence,
  assertRealMissionReleaseEvidence,
  safeChildExitSummary,
  safeRealMissionFailureReceipt,
  safeRealMissionFailureSummary,
} from "./e2e-real-mission-evidence.mjs";

const PRODUCT_WIZARD_RUNNER_AUTHORITY = Symbol(
  "product-wizard-runner-authority",
);
const RUNTIME_ATTESTATION_DOMAIN =
  "nexus-real-mission-runtime-attestation-v1";
const RUNTIME_ATTESTATION_BUNDLE_ID = "com.nexuside.app";
const VERIFIED_RUNTIME_PROOFS = new WeakMap();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameHex(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !/^[a-f0-9]{64}$/u.test(left) ||
    !/^[a-f0-9]{64}$/u.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function createRuntimeAttestation(releaseBinding, launchSurface) {
  const binding = Object.freeze({
    version: 1,
    bundleId: RUNTIME_ATTESTATION_BUNDLE_ID,
    launchSurface,
    appVersion: releaseBinding.appVersion,
    commitSha: releaseBinding.commitSha,
    artifact: Object.freeze({
      sha256: releaseBinding.artifact.sha256,
      identity: releaseBinding.artifact.identity,
    }),
  });
  const secret = randomBytes(32);
  const challenge = randomBytes(32);
  return Object.freeze({
    binding,
    secret,
    challenge,
    childEnvironment: () => ({
      secret: secret.toString("base64url"),
      challenge: challenge.toString("base64url"),
      binding: Buffer.from(canonicalJson(binding), "utf8").toString(
        "base64url",
      ),
    }),
  });
}

function verifyRuntimeAttestation(rawEvidence, attestation, issueProof = true) {
  const receipt = record(rawEvidence?.runtimeAttestation);
  if (
    receipt?.version !== 1 ||
    receipt?.algorithm !== "hmac-sha256"
  ) {
    throw new Error("real mission runtime attestation is missing");
  }
  const bindingSha256 = sha256(canonicalJson(attestation.binding));
  const challengeSha256 = sha256(attestation.challenge);
  const unsigned = {
    ...rawEvidence,
    runtimeAttestation: null,
  };
  const evidenceSha256 = sha256(canonicalJson(unsigned));
  const message = canonicalJson({
    domain: RUNTIME_ATTESTATION_DOMAIN,
    challenge: attestation.challenge.toString("base64url"),
    bindingSha256,
    evidenceSha256,
  });
  const macSha256 = createHmac("sha256", attestation.secret)
    .update(message)
    .digest("hex");
  if (
    !sameHex(receipt.challengeSha256, challengeSha256) ||
    !sameHex(receipt.bindingSha256, bindingSha256) ||
    !sameHex(receipt.evidenceSha256, evidenceSha256) ||
    !sameHex(receipt.macSha256, macSha256)
  ) {
    throw new Error(
      "real mission runtime attestation failed challenge/binding/evidence verification",
    );
  }
  if (!issueProof) {
    return Object.freeze({
      evidenceSha256,
      bindingSha256,
      challengeSha256,
    });
  }
  const proof = Object.freeze({});
  VERIFIED_RUNTIME_PROOFS.set(proof, Object.freeze({
    evidenceSha256,
    bindingSha256,
    releaseBinding: attestation.binding,
    runtimeAttestation: Object.freeze({ ...receipt }),
  }));
  return proof;
}

/**
 * Cryptographic compatibility test core. It validates bytes but deliberately
 * cannot mint the opaque live proof accepted by release/security/publish.
 */
export function verifyRuntimeAttestationTestCore(
  rawEvidence,
  { secret, challenge, binding },
) {
  if (
    !Buffer.isBuffer(secret) ||
    secret.byteLength !== 32 ||
    !Buffer.isBuffer(challenge) ||
    challenge.byteLength !== 32 ||
    !record(binding)
  ) {
    throw new Error("runtime attestation test core requires bounded inputs");
  }
  return verifyRuntimeAttestation(
    rawEvidence,
    { secret, challenge, binding },
    false,
  );
}

export function assertVerifiedRealMissionRuntimeProof(
  proof,
  { evidence, releaseBinding },
) {
  const verified = VERIFIED_RUNTIME_PROOFS.get(proof);
  if (!verified) {
    throw new Error(
      "physical release authority requires a live verified runtime proof",
    );
  }
  const { release: _release, ...appEvidence } = evidence ?? {};
  const actualEvidenceSha256 = sha256(canonicalJson({
    ...appEvidence,
    runtimeAttestation: null,
  }));
  if (
    evidence?.runtimeAttestation?.evidenceSha256 !==
      verified.evidenceSha256 ||
    canonicalJson(evidence?.runtimeAttestation) !==
      canonicalJson(verified.runtimeAttestation) ||
    actualEvidenceSha256 !== verified.evidenceSha256 ||
    sha256(canonicalJson({
      version: 1,
      bundleId: RUNTIME_ATTESTATION_BUNDLE_ID,
      launchSurface: evidence?.launchSurface,
      appVersion: releaseBinding?.appVersion,
      commitSha: releaseBinding?.commitSha,
      artifact: releaseBinding?.artifact,
    })) !== verified.bindingSha256 ||
    evidence?.release?.appVersion !== releaseBinding?.appVersion ||
    evidence?.release?.commitSha !== releaseBinding?.commitSha ||
    evidence?.release?.artifact?.sha256 !==
      releaseBinding?.artifact?.sha256 ||
    evidence?.release?.artifact?.identity !==
      releaseBinding?.artifact?.identity
  ) {
    throw new Error(
      "live runtime proof does not match the release evidence binding",
    );
  }
  return evidence;
}

async function atomicWriteEvidence(evidence, destination) {
  const content = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  await fsp.mkdir(path.dirname(destination), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  const candidate = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(candidate, content, {
      mode: PRIVATE_FILE_MODE,
      flag: "wx",
    });
    await fsp.rename(candidate, destination);
    await fsp.chmod(destination, PRIVATE_FILE_MODE);
  } finally {
    await fsp.rm(candidate, { force: true });
  }
}

/**
 * @typedef {'sigint' | 'sigterm' | 'timeout' | null} RealMissionInterrupt
 */

/**
 * Wait for the packaged real-mission child. On SIGINT/SIGTERM/timeout the
 * process tree is terminated gracefully (SIGTERM → SIGKILL) so main can flush
 * evidence on before-quit; the promise **resolves** with `interruptedBy` set
 * so the caller can still read the evidence file and emit accurate pane/
 * dispatch/handoff counts instead of hardcoded zeros.
 */
export async function waitForChild(
  target,
  userData,
  {
    timeoutMs = REAL_MISSION_TIMEOUT_MS,
    spawnImpl = spawn,
    environment = process.env,
    killTree = killProcessTree,
    codexBinary,
    launchSurface = "private-runner",
    attestation = null,
  } = {},
) {
  if (
    launchSurface !== "private-runner" &&
    launchSurface !== "product-wizard"
  ) {
    throw new Error("invalid real mission launch surface");
  }
  let phase = "spawned";
  let passLineSeen = false;
  /** Last FAIL line from the app (may carry real snapshot counts). */
  let appFailSummary = null;
  const childEnvironment = realMissionEnvironment(
      environment,
      userData,
      codexBinary,
      launchSurface,
      attestation,
    );
  let child;
  try {
    child = spawnImpl(target.binary, realMissionArgs(userData, launchSurface), {
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    });
  } finally {
    delete childEnvironment.NEXUS_REAL_MISSION_ATTESTATION_SECRET;
    delete childEnvironment.NEXUS_REAL_MISSION_ATTESTATION_CHALLENGE;
    delete childEnvironment.NEXUS_REAL_MISSION_ATTESTATION_BINDING;
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    /** @type {RealMissionInterrupt} */
    let interruptedBy = null;
    let terminationGrace = null;
    const signalHandlers = new Map();
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationGrace) clearTimeout(terminationGrace);
      for (const [signal, listener] of signalHandlers) {
        process.off(signal, listener);
      }
      handler(value);
    };
    const terminate = (reason) => {
      if (settled || interruptedBy) return;
      interruptedBy = reason;
      // Graceful first so Electron before-quit can write real-mission-evidence.json
      // with the live mission snapshot (pane/dispatch/handoff counts).
      try {
        killTree(child.pid, { platform: process.platform });
      } catch {
        // Best-effort; close handler still settles.
      }
      terminationGrace = setTimeout(() => {
        finish(resolve, {
          code: 1,
          phase,
          passLineSeen,
          interruptedBy,
          appFailSummary,
          forcedClose: true,
        });
      }, 10_000);
    };
    const append = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/u)) {
        const phaseMatch = /^\[real-mission\] PHASE phase=([a-z-]+)$/u.exec(
          line,
        );
        if (phaseMatch && REAL_MISSION_CHILD_PHASES.has(phaseMatch[1])) {
          phase = phaseMatch[1];
          continue;
        }
        if (
          /^\[real-mission\] PASS mission=[A-Za-z0-9][A-Za-z0-9._:-]{0,255} evidence=real-mission-evidence\.json$/u.test(
            line,
          )
        ) {
          passLineSeen = true;
          continue;
        }
        // Capture the app's own FAIL summary (includes real pane counts).
        if (line.startsWith("[real-mission] FAIL ")) {
          appFailSummary = line;
        }
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code) => {
      finish(resolve, {
        code: Number.isInteger(code) ? code : 1,
        phase,
        passLineSeen,
        interruptedBy,
        appFailSummary,
        forcedClose: false,
      });
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const listener = () =>
        terminate(signal === "SIGINT" ? "sigint" : "sigterm");
      signalHandlers.set(signal, listener);
      process.once(signal, listener);
    }
    const timeout = setTimeout(() => {
      terminate("timeout");
    }, timeoutMs);
  });
}

async function runPackagedRealMissionCore(
  appPath,
  {
    evidencePath = path.join(process.cwd(), "out", REAL_MISSION_EVIDENCE_FILE),
    timeoutMs = REAL_MISSION_TIMEOUT_MS,
    spawnImpl = spawn,
    environment = process.env,
    killTree = killProcessTree,
    releaseBinding,
    launchSurface = "private-runner",
    now = () => new Date(),
    runId = randomUUID(),
    productWizardAuthority = null,
  } = {},
) {
  if (process.platform !== "darwin") {
    throw new Error(
      "the packaged real-mission release gate currently requires macOS",
    );
  }
  if (
    launchSurface !== "private-runner" &&
    launchSurface !== "product-wizard"
  ) {
    throw new Error("invalid real mission launch surface");
  }
  if (
    launchSurface === "product-wizard" &&
    productWizardAuthority !== PRODUCT_WIZARD_RUNNER_AUTHORITY
  ) {
    throw new Error(
      "product-wizard runner requires sealed production authority",
    );
  }
  const target = resolvePackagedTarget(appPath, {
    platform: process.platform,
    arch: process.arch,
  });
  await fsp.access(target.binary, fs.constants.X_OK);
  if (
    !record(releaseBinding) ||
    typeof releaseBinding.appVersion !== "string" ||
    typeof releaseBinding.commitSha !== "string" ||
    !record(releaseBinding.artifact)
  ) {
    throw new Error("release binding is required for the real mission gate");
  }
  const startedAt = now().toISOString();
  const runtimeAttestation = createRuntimeAttestation(
    releaseBinding,
    launchSurface,
  );

  const realHome = os.homedir();
  let userData = null;
  try {
    userData = await fsp.mkdtemp(
      path.join(os.tmpdir(), "nexus-real-mission-"),
    );
    await fsp.chmod(userData, PRIVATE_DIRECTORY_MODE);
    await fsp.mkdir(path.join(userData, "tmp"), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    const sourceCodexHome = path.join(realHome, ".codex");
    const codexBinary = resolveTrustedCodexBinary({ environment });
    stageTrustedCodexLauncher(codexBinary, userData);
    const isolatedEnvironment = realMissionEnvironment(
      environment,
      userData,
      codexBinary,
      launchSurface,
    );
    stageCodexAuthentication(sourceCodexHome, isolatedEnvironment.HOME);
    // Isolated HOME has no ~/.nexus/onboarding.json. Without a completed seed
    // the welcome modal covers MissionWizard and the product-wizard gate dies
    // at product-wizard-ready with missing-evidence.
    stageRealMissionOnboardingComplete(isolatedEnvironment.HOME);
    assertCodexReady({
      environment: isolatedEnvironment,
      codexBinary,
    });
    const result = await waitForChild(target, userData, {
      timeoutMs,
      spawnImpl,
      environment: isolatedEnvironment,
      killTree,
      codexBinary,
      launchSurface,
      attestation: runtimeAttestation.childEnvironment(),
    });
    const appEvidencePath = path.join(userData, REAL_MISSION_EVIDENCE_FILE);
    let rawEvidence = null;
    try {
      rawEvidence = JSON.parse(await fsp.readFile(appEvidencePath, "utf8"));
    } catch {
      rawEvidence = null;
    }

    // Interrupted gate: prefer on-disk evidence snapshot (written on before-quit
    // after SIGTERM), then the app FAIL line, then a phase-aware zero summary.
    if (result.interruptedBy) {
      let summary;
      if (rawEvidence) {
        summary = safeRealMissionFailureSummary(rawEvidence, result);
        // Stamp the interrupt code when the app only recorded a generic failure.
        if (
          result.interruptedBy === "sigint" ||
          result.interruptedBy === "sigterm" ||
          result.interruptedBy === "timeout"
        ) {
          summary = summary.replace(
            /code=[a-z0-9-]+/u,
            `code=${result.interruptedBy}`,
          );
        }
      } else if (
        typeof result.appFailSummary === "string" &&
        result.appFailSummary.startsWith("[real-mission] FAIL ")
      ) {
        summary = result.appFailSummary.includes("CTA:")
          ? result.appFailSummary
          : `${result.appFailSummary} CTA: ${REAL_MISSION_CTA}`;
      } else {
        const child = safeChildExitSummary(result);
        summary =
          `[real-mission] FAIL code=${result.interruptedBy} ` +
          `reason=none exit=${child.exitCode} phase=${child.phase} ` +
          `status=unknown panes=0 dispatches=0 handoffs=0 ` +
          `CTA: ${REAL_MISSION_CTA}`;
      }
      if (rawEvidence) {
        try {
          const receipt = safeRealMissionFailureReceipt(
            rawEvidence,
            result,
            releaseBinding,
            launchSurface,
          );
          await atomicWriteEvidence(receipt, evidencePath);
        } catch {
          // Summary is still the primary diagnostic for the operator.
        }
      }
      throw new Error(summary);
    }

    if (!rawEvidence) {
      const child = safeChildExitSummary(result);
      throw new Error(
        `[real-mission] FAIL code=missing-evidence exit=${child.exitCode} ` +
          `phase=${child.phase} status=none panes=0 ` +
          `dispatches=0 handoffs=0 CTA: ${REAL_MISSION_CTA}`,
      );
    }
    const runtimeProof = verifyRuntimeAttestation(
      rawEvidence,
      runtimeAttestation,
    );
    if (result.code !== 0 || rawEvidence?.status !== "pass") {
      const summary = safeRealMissionFailureSummary(rawEvidence, result);
      const receipt = safeRealMissionFailureReceipt(
        rawEvidence,
        result,
        releaseBinding,
        launchSurface,
      );
      try {
        await atomicWriteEvidence(receipt, evidencePath);
      } catch {
        throw new Error(`${summary}; failure receipt could not be persisted`);
      }
      throw new Error(summary);
    }
    if (rawEvidence?.appVersion !== releaseBinding.appVersion) {
      throw new Error(
        "real mission app version does not match the exact release binding",
      );
    }
    const evidence = assertRealMissionPassEvidence({
      ...rawEvidence,
      release: {
        ...releaseBinding,
        runId,
        startedAt,
        finishedAt: now().toISOString(),
      },
    });
    if (
      evidence.launchSurface !== launchSurface ||
      (launchSurface === "private-runner" &&
        evidence.wizardCoverage !== "not-covered") ||
      (launchSurface === "product-wizard" &&
        evidence.wizardCoverage !== "main-owned-product-sequence")
    ) {
      throw new Error(
        "real mission evidence launch surface does not match the main-owned runner mode",
      );
    }
    if (launchSurface === "product-wizard") {
      assertRealMissionReleaseEvidence(evidence);
    }
    if (!result.passLineSeen) {
      const child = safeChildExitSummary(result);
      throw new Error(
        `[real-mission] FAIL code=missing-pass-line exit=${child.exitCode} ` +
          `phase=${child.phase} status=done panes=0 ` +
          `dispatches=0 handoffs=0 CTA: ${REAL_MISSION_CTA}`,
      );
    }
    await atomicWriteEvidence(evidence, evidencePath);
    return { evidence, evidencePath, target, runtimeProof };
  } finally {
    runtimeAttestation.secret.fill(0);
    runtimeAttestation.challenge.fill(0);
    if (userData !== null) {
      // Preserve the last failed gate state for local diagnosis when requested.
      if (environment.NEXUS_REAL_MISSION_PRESERVE_USERDATA === "1") {
        process.stderr.write(`[real-mission] preserved userData=${userData}\n`);
      } else {
        await fsp.rm(userData, { recursive: true, force: true });
      }
    }
  }
}

export function runPackagedRealMission(appPath, options = {}) {
  if (
    options.launchSurface !== undefined &&
    options.launchSurface !== "private-runner"
  ) {
    throw new Error(
      "generic real-mission runner is private diagnostic-only",
    );
  }
  return runPackagedRealMissionCore(appPath, {
    ...options,
    launchSurface: "private-runner",
  });
}

export function runPackagedRealMissionProductWizard(
  appPath,
  options = {},
) {
  if (options === null || typeof options !== "object") {
    throw new Error(
      "sealed product-wizard runner rejects dependency override: prototype",
    );
  }
  const allowed = new Set([
    "evidencePath",
    "timeoutMs",
    "environment",
    "releaseBinding",
  ]);
  const prototype = Object.getPrototypeOf(options);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  const unexpected = keys.find(
    (key) =>
      typeof key !== "string" ||
      !allowed.has(key) ||
      descriptors[key]?.get !== undefined ||
      descriptors[key]?.set !== undefined,
  );
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    unexpected !== undefined
  ) {
    throw new Error(
      `sealed product-wizard runner rejects dependency override: ${String(unexpected ?? "prototype")}`,
    );
  }
  return runPackagedRealMissionCore(appPath, {
    evidencePath: descriptors.evidencePath?.value,
    timeoutMs: descriptors.timeoutMs?.value,
    environment: descriptors.environment?.value,
    releaseBinding: descriptors.releaseBinding?.value,
    launchSurface: "product-wizard",
    productWizardAuthority: PRODUCT_WIZARD_RUNNER_AUTHORITY,
  });
}
