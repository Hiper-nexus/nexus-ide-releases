/**
 * F-764 (A.1) — prova, no app EMPACOTADO (Developer ID + hardened runtime,
 * fuse `EnableNodeCliInspectArguments` desligado), que o watchdog da main
 * thread captura o profile JS durante um travamento:
 *
 *   node scripts/smoke-packaged-app.mjs --verify-hang-probe [--app <caminho>]
 *
 * Roda o smoke empacotado normal com NEXUS_SMOKE_HANG_PROBE=1: a main trava
 * ~40 s no carregamento (src/main/hang-watchdog/smoke-hang-probe.ts), a worker
 * do watchdog perfila pelo inspector e grava `logs/main-hang.ndjson` e
 * `logs/main-hang-<ts>.cpuprofile` no perfil temporário. Este harness exige o
 * profile gravado, um `.cpuprofile` válido com o laço do probe no topo — e o
 * resto do smoke (renderer + sondas funcionais) passando depois do travamento.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPackagedSmoke } from './smoke-packaged-app.mjs';

/** Espelham src/main/hang-watchdog/smoke-hang-probe.ts (contrato testado). */
export const HANG_PROBE_ENV = 'NEXUS_SMOKE_HANG_PROBE';
export const HANG_PROBE_FUNCTION = 'nexusSmokeInducedMainHang';
export const HANG_PROBE_BLOCK_MS = 40_000;
export const HANG_PROBE_TIMEOUT_MS = 75_000;
const PROFILE_FILE_RE = /^main-hang-[^/\\]+\.cpuprofile$/u;

export function parseHangProbeArguments(args) {
  let app = null;
  let verify = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--verify-hang-probe' && !verify) {
      verify = true;
    } else if (flag === '--app' && app === null) {
      const value = args[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new Error('missing value for --app');
      }
      app = path.resolve(value);
    } else {
      throw new Error(`invalid or duplicate hang probe argument: ${String(flag)}`);
    }
  }
  if (!verify) throw new Error('hang probe requires --verify-hang-probe');
  return { app };
}

/** Linhas do `main-hang.ndjson`; linha corrompida é ignorada, não fatal. */
export function readHangRecords(text) {
  const records = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object') records.push(record);
    } catch {
      // Linha truncada no meio de uma gravação.
    }
  }
  return records;
}

/** O que o app empacotado tem de ter gravado para o probe passar. */
export function assertHangProbeProof({ records, profile }) {
  const capture = records.find((record) => record.kind === 'main-thread-hang-profile');
  const hang = records.find((record) => record.kind === 'main-thread-hang' &&
    (!capture || record.lastHeartbeatAt === capture.lastHeartbeatAt));
  if (!hang) throw new Error('hang probe: o watchdog não marcou o travamento induzido');
  if (!capture) throw new Error('hang probe: o watchdog não registrou a captura do profile');
  if (capture.profilerUnavailable) {
    throw new Error(`hang probe: inspector indisponível no app empacotado: ${capture.profilerUnavailable}`);
  }
  if (typeof capture.profileFile !== 'string' || !PROFILE_FILE_RE.test(capture.profileFile)) {
    throw new Error('hang probe: o profile não foi gravado em disco');
  }
  const top = Array.isArray(capture.topFrames) ? capture.topFrames[0] : undefined;
  if (top?.functionName !== HANG_PROBE_FUNCTION) {
    throw new Error(
      `hang probe: topo do profile é ${top?.functionName ?? 'vazio'}, esperado ${HANG_PROBE_FUNCTION}`,
    );
  }
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : null;
  if (!nodes || !Array.isArray(profile.samples) || profile.samples.length === 0 ||
      !nodes.some((node) => node?.callFrame?.functionName === HANG_PROBE_FUNCTION)) {
    throw new Error(`hang probe: ${capture.profileFile} não é um .cpuprofile com o laço do probe`);
  }
  const recovery = records.find(record => record.kind === 'main-thread-hang-recovered' &&
    Number.isFinite(capture.lastHeartbeatAt) && record.lastHeartbeatAt === capture.lastHeartbeatAt);
  if (!recovery) throw new Error('hang probe: falta recuperação do mesmo episódio de travamento');
  if (!Number.isFinite(recovery.hangDurationMs) || recovery.hangDurationMs < HANG_PROBE_BLOCK_MS ||
    recovery.recoveredAt - recovery.lastHeartbeatAt !== recovery.hangDurationMs) {
    throw new Error('hang probe: recuperação não prova o bloqueio exigido de 40 segundos');
  }
  return {
    schema: 'nexus.hang-probe/v2',
    requiredDurationMs: HANG_PROBE_BLOCK_MS,
    hangDurationMs: recovery.hangDurationMs,
    profileFile: capture.profileFile,
    sampleCount: capture.sampleCount,
    top: {
      functionName: top.functionName,
      selfPercent: top.selfPercent,
      url: top.url,
      line: top.line,
      column: top.column,
    },
  };
}

/** Espera a linha do profile no perfil temporário do smoke e valida tudo. */
export async function waitForHangProof(userData, {
  signal,
  timeoutMs = HANG_PROBE_TIMEOUT_MS,
  pollMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const logsDir = path.join(userData, 'logs');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error('hang probe: cancelado pelo smoke');
    let records = [];
    try {
      records = readHangRecords(await fs.readFile(path.join(logsDir, 'main-hang.ndjson'), 'utf8'));
    } catch {
      // Ainda não existe.
    }
    const capture = records.find((record) => record.kind === 'main-thread-hang-profile');
    const recovered = capture && records.some(record => record.kind === 'main-thread-hang-recovered' &&
      record.lastHeartbeatAt === capture.lastHeartbeatAt);
    if (capture && (recovered || capture.profilerUnavailable)) {
      let profile = null;
      if (typeof capture.profileFile === 'string' && PROFILE_FILE_RE.test(capture.profileFile)) {
        try {
          profile = JSON.parse(await fs.readFile(path.join(logsDir, capture.profileFile), 'utf8'));
        } catch {
          profile = null;
        }
      }
      return assertHangProbeProof({ records, profile });
    }
    if (Date.now() > deadline) {
      throw new Error(`hang probe: nenhum profile em ${logsDir} após ${timeoutMs} ms`);
    }
    await sleep(pollMs);
  }
}

export async function runPackagedHangProbe(targetPath, {
  runSmoke = runPackagedSmoke,
  env = process.env,
  ...smokeOptions
} = {}) {
  const result = await runSmoke(targetPath, {
    ...smokeOptions,
    env: { ...env, [HANG_PROBE_ENV]: '1' },
    runtimeProbe: (_child, { userData, signal }) => waitForHangProof(userData, { signal }),
    runtimeProbeTimeoutMs: HANG_PROBE_TIMEOUT_MS + 5_000,
  });
  const proof = result?.runtimeProof;
  if (!proof || proof.schema !== 'nexus.hang-probe/v2') {
    throw new Error('packaged hang probe did not return its proof');
  }
  process.stdout.write(`[smoke] hangProbeProof ${JSON.stringify(proof)}\n`);
  return proof;
}
