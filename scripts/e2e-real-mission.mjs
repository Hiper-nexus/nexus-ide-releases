import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  killProcessTree,
  resolvePackagedTarget,
} from './smoke-packaged-app.mjs';

export const REAL_MISSION_FLAG = '--nexus-real-mission-e2e';
export const REAL_MISSION_TIMEOUT_MS = 16 * 60_000;
export const REAL_MISSION_EVIDENCE_FILE = 'real-mission-evidence.json';
export const REAL_MISSION_EXPECTED_CONTENT = 'nexus-real-mission-e2e-ok\n';
export const REAL_MISSION_CTA =
  'Abra o relatório de evidências, corrija o estado bloqueado e execute novamente antes da release.';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const REAL_MISSION_CHILD_PHASES = new Set([
  'spawned',
  'booting',
  'renderer-mounted',
  'orchestration-ready',
  'fixture-persisted',
  'fixture-prepared',
  'observer-armed',
]);
const REAL_MISSION_FAILURE_CODES = new Set([
  'setup-failed',
  'renderer-failed',
  'observer-invalid',
  'mission-blocked',
  'mission-failed',
  'invariant-failed',
  'timeout',
  'app-error',
]);
const REAL_MISSION_FAILURE_REASONS = new Set([
  'boot_timeout',
  'timeout',
  'session_exited',
  'write_failed',
  'authority_lost',
]);
const REAL_MISSION_STATUSES = new Set([
  'pending',
  'running',
  'blocked',
  'done',
  'failed',
]);
const SAFE_CHILD_ENV_KEYS = new Set([
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TZ',
  'USER',
]);
const RELEASE_IDENTITY_PATTERN =
  /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

export function parseRealMissionArgs(argv) {
  const result = { appPath: null, evidencePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--app' && flag !== '--evidence') {
      throw new Error(
        'usage: e2e-real-mission.mjs [--app /path/NexusIDE.app] [--evidence /path/evidence.json]',
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`);
    }
    if (flag === '--app') result.appPath = path.resolve(value);
    else result.evidencePath = path.resolve(value);
    index += 1;
  }
  return result;
}

export function realMissionArgs(userData) {
  return [
    `--user-data-dir=${path.resolve(userData)}`,
    '--',
    REAL_MISSION_FLAG,
  ];
}

export function realMissionEnvironment(baseEnv, userData, codexBinary) {
  const environment = Object.fromEntries(
    Object.entries(baseEnv).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        SAFE_CHILD_ENV_KEYS.has(key),
    ),
  );
  const isolatedUserData = path.resolve(userData);
  const home = path.join(isolatedUserData, 'home');
  const tmp = path.join(isolatedUserData, 'tmp');
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PATH: [
      path.join(isolatedUserData, 'trusted-bin'),
      path.dirname(process.execPath),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(path.delimiter),
    NEXUS_USER_DATA_DIR: isolatedUserData,
  };
}

function stageTrustedCodexLauncher(codexBinary, userData) {
  const directory = path.join(path.resolve(userData), 'trusted-bin');
  fs.mkdirSync(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const launcher = path.join(directory, 'codex');
  fs.symlinkSync(path.resolve(codexBinary), launcher, 'file');
  return launcher;
}

function defaultResolveCommand(command, environment) {
  const result = spawnSync('/usr/bin/which', [command], {
    encoding: 'utf8',
    env: {
      PATH: environment.PATH ?? '',
      LANG: environment.LANG ?? 'C',
    },
    shell: false,
    timeout: 15_000,
  });
  if (result.status !== 0) return '';
  return (result.stdout ?? '').split(/\r?\n/u).find(Boolean) ?? '';
}

export function resolveTrustedCodexBinary({
  environment = process.env,
  resolveCommand = defaultResolveCommand,
} = {}) {
  const unresolved = resolveCommand('codex', environment);
  if (typeof unresolved !== 'string' || !path.isAbsolute(unresolved)) {
    throw new Error('codex CLI was not found at an absolute path');
  }
  const binary = fs.realpathSync(unresolved);
  const stat = fs.statSync(binary);
  if (
    !stat.isFile() ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error('refusing an untrusted or writable codex CLI binary');
  }
  if (
    typeof process.getuid === 'function' &&
    stat.uid !== process.getuid() &&
    stat.uid !== 0
  ) {
    throw new Error('refusing a codex CLI binary owned by another user');
  }
  const normalized = binary.replaceAll('\\', '/');
  const suffix = '/node_modules/@openai/codex/bin/codex.js';
  if (!normalized.endsWith(suffix)) {
    throw new Error('codex binary is not the official Codex package entrypoint');
  }
  const packageRoot = binary.slice(0, -'/bin/codex.js'.length);
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageStat = fs.lstatSync(packageJsonPath);
  if (
    packageStat.isSymbolicLink() ||
    !packageStat.isFile() ||
    (packageStat.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' &&
      packageStat.uid !== process.getuid() &&
      packageStat.uid !== 0)
  ) {
    throw new Error('codex package metadata is not trusted');
  }
  const packageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, 'utf8'),
  );
  if (packageJson?.name !== '@openai/codex') {
    throw new Error('codex binary is not the official Codex package');
  }
  return binary;
}

/**
 * Copy only Codex's authentication receipt into the private disposable HOME.
 * User config, plugins, sessions and Nexus state stay outside the release gate.
 */
export function stageCodexAuthentication(sourceCodexHome, isolatedHome) {
  const source = path.join(path.resolve(sourceCodexHome), 'auth.json');
  let descriptor;
  try {
    descriptor = fs.openSync(
      source,
      fs.constants.O_RDONLY |
        (typeof fs.constants.O_NOFOLLOW === 'number'
          ? fs.constants.O_NOFOLLOW
          : 0),
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (error?.code === 'ELOOP') {
      throw new Error('refusing to stage a non-regular Codex auth file');
    }
    throw error;
  }
  let destination = '';
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error('refusing to stage a non-regular Codex auth file');
    }
    if ((before.mode & 0o077) !== 0) {
      throw new Error('Codex auth file must use private mode 0600');
    }
    if (
      typeof process.getuid === 'function' &&
      before.uid !== process.getuid()
    ) {
      throw new Error('Codex auth file must be owned by the release operator');
    }
    if (before.size > 4 * 1024 * 1024) {
      throw new Error('refusing to stage an oversized Codex auth file');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(source);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino ||
      after.size !== pathStat.size
    ) {
      throw new Error('Codex auth file changed while it was being staged');
    }
    const destinationDirectory = path.join(
      path.resolve(isolatedHome),
      '.codex',
    );
    fs.mkdirSync(destinationDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    fs.chmodSync(destinationDirectory, PRIVATE_DIRECTORY_MODE);
    destination = path.join(destinationDirectory, 'auth.json');
    fs.writeFileSync(destination, bytes, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    fs.chmodSync(destination, PRIVATE_FILE_MODE);
    return true;
  } catch (error) {
    if (destination) {
      try {
        fs.rmSync(destination, { force: true });
      } catch {
        // Best effort only: never replace the original staging failure.
      }
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertCodexReady({
  run = spawnSync,
  environment = process.env,
  codexBinary,
} = {}) {
  if (typeof codexBinary !== 'string' || !path.isAbsolute(codexBinary)) {
    throw new Error('trusted absolute codex CLI path is required');
  }
  const version = run(codexBinary, ['--version'], {
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: 15_000,
  });
  if (
    version.status !== 0 ||
    !/^codex-cli \d+\.\d+\.\d+/mu.test(version.stdout ?? '')
  ) {
    throw new Error('codex CLI is not installed or executable');
  }
  const login = run(codexBinary, ['login', 'status'], {
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout: 30_000,
  });
  const loginText = `${login.stdout ?? ''}\n${login.stderr ?? ''}`;
  if (
    login.status !== 0 ||
    !/^\s*Logged in(?:\s+using\b[^\r\n]*)?\s*$/imu.test(loginText)
  ) {
    throw new Error('codex CLI is not authenticated');
  }
  return {
    installed: true,
    authenticated: true,
    version: (version.stdout ?? '').trim().slice(0, 64),
  };
}

function assertNoSecretFields(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSecretFields(item, [...pathParts, String(index)]),
    );
    return;
  }
  const item = record(value);
  if (!item) return;
  for (const [key, child] of Object.entries(item)) {
    if (
      /^(?:prompt|rawOutput|outputText|token|secret|credential|password|apiKey)$/iu.test(
        key,
      )
    ) {
      throw new Error(`forbidden evidence field: ${[...pathParts, key].join('.')}`);
    }
    assertNoSecretFields(child, [...pathParts, key]);
  }
}

export function assertRealMissionPassEvidence(raw) {
  assertNoSecretFields(raw);
  const evidence = record(raw);
  const mission = record(evidence?.mission);
  const kickoff = record(evidence?.kickoff);
  const repository = record(evidence?.repository);
  const release = record(evidence?.release);
  const artifact = record(release?.artifact);
  const startedAt = Date.parse(release?.startedAt ?? '');
  const finishedAt = Date.parse(release?.finishedAt ?? '');
  const canonicalStartedAt =
    Number.isFinite(startedAt) && new Date(startedAt).toISOString() === release?.startedAt;
  const canonicalFinishedAt =
    Number.isFinite(finishedAt) && new Date(finishedAt).toISOString() === release?.finishedAt;
  const panes = Array.isArray(evidence?.panes) ? evidence.panes : [];
  const dispatches = Array.isArray(evidence?.dispatches)
    ? evidence.dispatches
    : [];
  const handoffs = Array.isArray(evidence?.handoffs) ? evidence.handoffs : [];
  const expectedSha = sha256(REAL_MISSION_EXPECTED_CONTENT);
  const valid =
    evidence?.schemaVersion === 1 &&
    evidence?.status === 'pass' &&
    evidence?.failure === null &&
    evidence?.expectedContentSha256 === expectedSha &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(
      release?.appVersion ?? '',
    ) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      release?.runId ?? '',
    ) &&
    canonicalStartedAt &&
    canonicalFinishedAt &&
    finishedAt > startedAt &&
    /^[a-f0-9]{40}$/u.test(release?.commitSha ?? '') &&
    /^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? '') &&
    RELEASE_IDENTITY_PATTERN.test(artifact?.identity ?? '') &&
    mission?.status === 'done' &&
    mission?.squadId === 'nexus-real-mission-e2e' &&
    typeof kickoff?.sessionId === 'string' &&
    Number.isInteger(kickoff?.idleAt) &&
    Number.isInteger(kickoff?.busyAt) &&
    Number.isInteger(kickoff?.ptyDataAt) &&
    kickoff.idleAt <= kickoff.busyAt &&
    kickoff.idleAt <= kickoff.ptyDataAt &&
    /^[a-f0-9]{64}$/u.test(kickoff?.ptyChunkSha256 ?? '') &&
    panes.length === 2 &&
    panes.filter(
      (pane) =>
        pane?.role === 'orchestrator' &&
        pane?.adapterId === 'codex' &&
        pane?.agentRef === 'e2e-orchestrator',
    ).length === 1 &&
    panes.some(
      (pane) =>
        pane?.role === 'worker' &&
        pane?.adapterId === 'codex' &&
        pane?.agentRef === 'e2e-worker' &&
        typeof pane?.workerIncarnationId === 'string' &&
        Number.isInteger(pane?.ptySpawnedAt) &&
        Number.isInteger(pane?.ptyDataAt) &&
        pane.ptySpawnedAt <= pane.ptyDataAt &&
        /^[a-f0-9]{64}$/u.test(pane?.ptyChunkSha256 ?? ''),
    ) &&
    dispatches.length === 1 &&
    dispatches.every(
      (dispatch) =>
        dispatch?.state === 'completed' &&
        typeof dispatch?.routeReservationId === 'string' &&
        Number.isInteger(dispatch?.routeConsumedAt) &&
        dispatch?.routeConsumerMatches === true &&
        typeof dispatch?.workerIncarnationId === 'string' &&
        typeof dispatch?.sessionId === 'string' &&
        typeof dispatch?.handoffId === 'string' &&
        Number.isInteger(dispatch?.handoffAcceptedAt) &&
        dispatch?.integrationReceipt?.kind === 'worktree_integrated' &&
        /^[a-f0-9]{40,64}$/u.test(
          dispatch?.integrationReceipt?.referenceSha ?? '',
        ),
    ) &&
    handoffs.length === 1 &&
    handoffs.every(
      (handoff) =>
        handoff?.status === 'success' &&
        handoff?.delivered === true &&
        handoff?.deliveryState !== 'queued' &&
        Number.isInteger(handoff?.acceptedAt) &&
        typeof handoff?.acceptedBySessionId === 'string',
    ) &&
    /^[a-f0-9]{40,64}$/u.test(repository?.initialHeadSha ?? '') &&
    /^[a-f0-9]{40,64}$/u.test(repository?.finalHeadSha ?? '') &&
    repository?.resultSha256 === expectedSha &&
    Number.isInteger(repository?.commitCount) &&
    repository.commitCount === 2 &&
    repository?.clean === true &&
    repository?.changedBeforeWorker === false &&
    repository?.exactSingleCommit === true &&
    repository?.initialHeadSha !== repository?.finalHeadSha &&
    dispatches[0]?.integrationReceipt?.referenceSha ===
      repository?.finalHeadSha &&
    panes.find((pane) => pane?.agentRef === 'e2e-orchestrator')?.sessionId ===
      kickoff?.sessionId &&
    panes.find((pane) => pane?.agentRef === 'e2e-worker')?.sessionId ===
      dispatches[0]?.sessionId &&
    panes.find((pane) => pane?.agentRef === 'e2e-worker')
      ?.workerIncarnationId === dispatches[0]?.workerIncarnationId &&
    handoffs[0]?.id === dispatches[0]?.handoffId;
  const currentSessionAccepted =
    handoffs[0]?.acceptedBySessionId === kickoff?.sessionId;
  if (!valid || !currentSessionAccepted) {
    throw new Error('real mission evidence is incomplete or not a PASS');
  }
  return evidence;
}

function safeChildExitSummary(result) {
  const exitCode =
    Number.isInteger(result?.code) &&
    result.code >= 0 &&
    result.code <= 255
      ? result.code
      : 1;
  const phase = REAL_MISSION_CHILD_PHASES.has(result?.phase)
    ? result.phase
    : 'spawned';
  return { exitCode, phase };
}

function safeEvidenceCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 64 ? value : 0;
}

function safeRealMissionFailureParts(raw, result) {
  const evidence = record(raw);
  const failure = record(evidence?.failure);
  const snapshot = record(failure?.snapshot);
  const child = safeChildExitSummary(result);
  const failureCode = REAL_MISSION_FAILURE_CODES.has(failure?.code)
    ? failure.code
    : 'invalid-evidence';
  const failureReason = REAL_MISSION_FAILURE_REASONS.has(failure?.reason)
    ? failure.reason
    : null;
  const missionStatus = REAL_MISSION_STATUSES.has(snapshot?.missionStatus)
    ? snapshot.missionStatus
    : null;
  return {
    child,
    failure: {
      code: failureCode,
      reason: failureReason,
      cta: REAL_MISSION_CTA,
      snapshot: {
        missionStatus,
        paneCount: safeEvidenceCount(snapshot?.paneCount),
        dispatchCount: safeEvidenceCount(snapshot?.dispatchCount),
        handoffCount: safeEvidenceCount(snapshot?.handoffCount),
      },
    },
  };
}

export function safeRealMissionFailureReceipt(
  raw,
  result,
  releaseBinding,
) {
  const { child, failure } = safeRealMissionFailureParts(raw, result);
  const release = record(releaseBinding);
  const artifact = record(release?.artifact);
  return {
    schemaVersion: 1,
    status: 'fail',
    release: {
      appVersion:
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(
          release?.appVersion ?? '',
        )
          ? release.appVersion
          : null,
      commitSha: /^[a-f0-9]{40}$/u.test(release?.commitSha ?? '')
        ? release.commitSha
        : null,
      artifact: {
        sha256: /^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? '')
          ? artifact.sha256
          : null,
        identity: RELEASE_IDENTITY_PATTERN.test(artifact?.identity ?? '')
          ? artifact.identity
          : null,
      },
    },
    child,
    failure,
  };
}

export function safeRealMissionFailureSummary(raw, result) {
  const { child, failure } = safeRealMissionFailureParts(raw, result);
  const snapshot = failure.snapshot;
  return (
    `[real-mission] FAIL code=${failure.code} ` +
    `reason=${failure.reason ?? 'none'} ` +
    `exit=${child.exitCode} phase=${child.phase} ` +
    `status=${snapshot.missionStatus ?? 'none'} ` +
    `panes=${snapshot.paneCount} ` +
    `dispatches=${snapshot.dispatchCount} ` +
    `handoffs=${snapshot.handoffCount} ` +
    `CTA: ${REAL_MISSION_CTA}`
  );
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
      flag: 'wx',
    });
    await fsp.rename(candidate, destination);
    await fsp.chmod(destination, PRIVATE_FILE_MODE);
  } finally {
    await fsp.rm(candidate, { force: true });
  }
}

export async function waitForChild(
  target,
  userData,
  {
    timeoutMs = REAL_MISSION_TIMEOUT_MS,
    spawnImpl = spawn,
    environment = process.env,
    killTree = killProcessTree,
    codexBinary,
  } = {},
) {
  let phase = 'spawned';
  let passLineSeen = false;
  const child = spawnImpl(target.binary, realMissionArgs(userData), {
    env: realMissionEnvironment(environment, userData, codexBinary),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: process.platform === 'win32',
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    let terminationError = null;
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
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      Promise.resolve(
        killTree(child.pid, { platform: process.platform }),
      ).catch(() => undefined);
      terminationGrace = setTimeout(() => {
        finish(
          reject,
          new Error(`${error.message}; child did not close after termination`),
        );
      }, 10_000);
    };
    const append = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/u)) {
        const phaseMatch =
          /^\[real-mission\] PHASE phase=([a-z-]+)$/u.exec(line);
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
        }
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (terminationError) {
        finish(reject, terminationError);
      } else {
        finish(resolve, {
          code: Number.isInteger(code) ? code : 1,
          phase,
          passLineSeen,
        });
      }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const listener = () =>
        terminate(
          new Error(
            `[real-mission] FAIL code=${signal.toLowerCase()} ` +
              `status=unknown panes=0 dispatches=0 handoffs=0 ` +
              `CTA: ${REAL_MISSION_CTA}`,
          ),
        );
      signalHandlers.set(signal, listener);
      process.once(signal, listener);
    }
    const timeout = setTimeout(() => {
      terminate(
        new Error(
          `[real-mission] FAIL code=timeout status=unknown panes=0 dispatches=0 ` +
            `handoffs=0 CTA: ${REAL_MISSION_CTA}`,
        ),
      );
    }, timeoutMs);
  });
}

export async function runPackagedRealMission(
  appPath,
  {
    evidencePath = path.join(process.cwd(), 'out', REAL_MISSION_EVIDENCE_FILE),
    timeoutMs = REAL_MISSION_TIMEOUT_MS,
    spawnImpl = spawn,
    environment = process.env,
    killTree = killProcessTree,
    releaseBinding,
    now = () => new Date(),
    runId = randomUUID(),
  } = {},
) {
  if (process.platform !== 'darwin') {
    throw new Error('the packaged real-mission release gate currently requires macOS');
  }
  const target = resolvePackagedTarget(appPath, {
    platform: process.platform,
    arch: process.arch,
  });
  await fsp.access(target.binary, fs.constants.X_OK);
  if (
    !record(releaseBinding) ||
    typeof releaseBinding.appVersion !== 'string' ||
    typeof releaseBinding.commitSha !== 'string' ||
    !record(releaseBinding.artifact)
  ) {
    throw new Error('release binding is required for the real mission gate');
  }
  const startedAt = now().toISOString();

  const realHome = os.homedir();
  const userData = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'nexus-real-mission-'),
  );
  await fsp.chmod(userData, PRIVATE_DIRECTORY_MODE);
  await fsp.mkdir(path.join(userData, 'tmp'), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });

  try {
    const sourceCodexHome = path.join(realHome, '.codex');
    const codexBinary = resolveTrustedCodexBinary({ environment });
    stageTrustedCodexLauncher(codexBinary, userData);
    const isolatedEnvironment = realMissionEnvironment(
      environment,
      userData,
      codexBinary,
    );
    stageCodexAuthentication(sourceCodexHome, isolatedEnvironment.HOME);
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
    });
    const appEvidencePath = path.join(userData, REAL_MISSION_EVIDENCE_FILE);
    let rawEvidence = null;
    try {
      rawEvidence = JSON.parse(await fsp.readFile(appEvidencePath, 'utf8'));
    } catch {
      const child = safeChildExitSummary(result);
      throw new Error(
        `[real-mission] FAIL code=missing-evidence exit=${child.exitCode} ` +
          `phase=${child.phase} status=none panes=0 ` +
          `dispatches=0 handoffs=0 CTA: ${REAL_MISSION_CTA}`,
      );
    }
    if (result.code !== 0 || rawEvidence?.status !== 'pass') {
      const summary = safeRealMissionFailureSummary(rawEvidence, result);
      const receipt = safeRealMissionFailureReceipt(
        rawEvidence,
        result,
        releaseBinding,
      );
      try {
        await atomicWriteEvidence(receipt, evidencePath);
      } catch {
        throw new Error(`${summary}; failure receipt could not be persisted`);
      }
      throw new Error(summary);
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
    if (!result.passLineSeen) {
      const child = safeChildExitSummary(result);
      throw new Error(
        `[real-mission] FAIL code=missing-pass-line exit=${child.exitCode} ` +
          `phase=${child.phase} status=done panes=0 ` +
          `dispatches=0 handoffs=0 CTA: ${REAL_MISSION_CTA}`,
      );
    }
    await atomicWriteEvidence(evidence, evidencePath);
    return { evidence, evidencePath, target };
  } finally {
    await fsp.rm(userData, { recursive: true, force: true });
  }
}

async function main() {
  parseRealMissionArgs(process.argv.slice(2));
  throw new Error(
    'direct E2E invocation is disabled: use npm run release:candidate so the ' +
      'verified ZIP, commit, signature and evidence stay bound',
  );
}

const isDirectRun = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectRun) {
  main().catch((error) => {
    const message =
      error instanceof Error && error.message.startsWith('[real-mission]')
        ? error.message
        : `[real-mission] FAIL code=harness-error status=unknown panes=0 ` +
          `dispatches=0 handoffs=0 CTA: ${REAL_MISSION_CTA}`;
    console.error(message);
    process.exitCode = 1;
  });
}
