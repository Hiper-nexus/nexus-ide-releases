/** F-764 C.7: real mounted-Main hang + rendered banner + recovered functional smoke. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPackagedSmoke } from './smoke-packaged-app.mjs';
import { assertHangProbeProof, readHangRecords, HANG_PROBE_ENV, HANG_PROBE_BLOCK_MS } from './smoke-packaged-hang-probe.mjs';

export const BUSY_BANNER_PROBE_ENV = 'NEXUS_SMOKE_BUSY_BANNER_PROBE';
const RECEIPT_FILE = 'busy-banner-smoke.json';
const TITLE = 'Nexus ocupado — capturando diagnóstico';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const PROFILE_FILE_RE = /^main-hang-[^/\\]+\.cpuprofile$/u;
const NONCE_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const timestamp = value => Number.isSafeInteger(value) && value > 0;

export function parseBusyBannerArguments(args) {
  const parsed = { app: null, expectedVersion: null, evidenceDir: null };
  const flags = { '--app': 'app', '--expected-version': 'expectedVersion', '--evidence-dir': 'evidenceDir' };
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--verify-busy-banner-probe' && !verify) { verify = true; continue; }
    const key = flags[flag];
    const value = args[++i];
    if (!key || parsed[key] !== null || typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('invalid busy banner probe argument');
    parsed[key] = key === 'expectedVersion' ? value : path.resolve(value);
  }
  if (!verify || !VERSION_RE.test(parsed.expectedVersion ?? '') || !parsed.evidenceDir) throw new Error('busy banner probe requires --verify-busy-banner-probe --expected-version <version> --evidence-dir <new-directory>');
  return parsed;
}

function captureForEpisode(records, main) {
  return records.find(record => record.kind === 'main-thread-hang-profile' &&
    timestamp(record.lastHeartbeatAt) && record.lastHeartbeatAt <= main.startedAt &&
    timestamp(record.capturedAt) && record.capturedAt > main.startedAt && record.capturedAt < main.recoveredAt);
}

/** Independently counts the raw inspector samples, instead of trusting topFrames. */
function independentTop(profile) {
  if (!Array.isArray(profile?.nodes) || !Array.isArray(profile.samples) || !profile.samples.length) throw new Error('busy banner probe profile is unreadable');
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
  const counts = new Map();
  for (const id of profile.samples) {
    const frame = nodes.get(id);
    if (!frame) throw new Error('busy banner probe profile contains an unknown sample');
    if (frame.functionName === '(root)' || frame.functionName === '(idle)') continue;
    const key = JSON.stringify([frame.functionName, frame.url, frame.lineNumber, frame.columnNumber]);
    const entry = counts.get(key) ?? { ...frame, samples: 0 };
    entry.samples++; counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.samples - a.samples)[0];
}

export function assertBusyBannerProof({ receipt, records, profile, pid, expectedVersion }) {
  const main = receipt?.main, renderer = receipt?.renderer;
  if (receipt?.schema !== 'nexus.busy-banner-smoke/v1' || receipt.pid !== pid || !timestamp(pid) ||
      receipt.packaged !== true || receipt.appVersion !== expectedVersion || !VERSION_RE.test(expectedVersion ?? '') ||
      !NONCE_RE.test(main?.nonce ?? '') || main.nonce !== renderer?.nonce ||
      !timestamp(main.startedAt) || !timestamp(main.recoveredAt) || main.recoveredAt - main.startedAt < HANG_PROBE_BLOCK_MS ||
      ![renderer?.armedAt, renderer?.shownAt, renderer?.visibleAt, renderer?.clearedAt].every(timestamp) ||
      renderer.armedAt > main.startedAt || renderer.shownAt < main.startedAt || renderer.visibleAt <= renderer.shownAt ||
      renderer.visibleAt >= main.recoveredAt || renderer.clearedAt < main.recoveredAt || renderer.title !== TITLE) {
    throw new Error('busy banner probe Main/renderer evidence is incomplete or from another episode');
  }
  const r = renderer.rect;
  if (!r || !['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'].every(key =>
    typeof r[key] === 'number' && Number.isFinite(r[key]) && r[key] >= 0 && r[key] <= 32_768) ||
      r.width <= 0 || r.height <= 0 || r.x + r.width > r.viewportWidth || r.y + r.height > r.viewportHeight) {
    throw new Error('busy banner probe banner was not visible inside the viewport');
  }
  const capture = captureForEpisode(records, main);
  if (!capture) throw new Error('busy banner probe lacks an inspector capture during the mounted Main hang');
  const episodeRecords = records.filter(record => record.lastHeartbeatAt === capture.lastHeartbeatAt);
  if (episodeRecords.some(record => record.appVersion !== expectedVersion)) throw new Error('busy banner watchdog version mismatch');
  const detected = episodeRecords.find(record => record.kind === 'main-thread-hang');
  const recovered = episodeRecords.find(record => record.kind === 'main-thread-hang-recovered');
  if (!timestamp(detected?.detectedAt) || detected.detectedAt < main.startedAt || detected.detectedAt >= main.recoveredAt ||
      !timestamp(recovered?.recoveredAt) || recovered.recoveredAt < main.recoveredAt) throw new Error('busy banner watchdog episode does not match the real Main hang');
  const watchdog = assertHangProbeProof({ records: episodeRecords, profile });
  const top = independentTop(profile);
  if (top?.functionName !== watchdog.top.functionName || typeof top.url !== 'string' || !top.url ||
      !Number.isSafeInteger(top.lineNumber) || top.lineNumber < 0 || !Number.isSafeInteger(top.columnNumber) || top.columnNumber < 0 ||
      top.url !== watchdog.top.url || top.lineNumber + 1 !== watchdog.top.line || top.columnNumber + 1 !== watchdog.top.column ||
      profile.samples.length !== watchdog.sampleCount) throw new Error('busy banner inspector samples do not prove the reported function and position');
  return {
    schema: 'nexus.busy-banner-acceptance/v1', pid, appVersion: expectedVersion, packaged: true,
    requiredDurationMs: HANG_PROBE_BLOCK_MS, mainDurationMs: main.recoveredAt - main.startedAt,
    main, banner: { ...renderer, onsetMs: renderer.shownAt - main.startedAt, clearedAfterRecoveryMs: renderer.clearedAt - main.recoveredAt },
    watchdog,
  };
}

export async function waitForBusyBannerProof(userData, {
  pid, expectedVersion, evidenceDir, signal, timeoutMs = 90_000, pollMs = 250,
} = {}) {
  const logs = path.join(userData, 'logs');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error('busy banner probe cancelled');
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(path.join(logs, RECEIPT_FILE), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (receipt) {
      const ndjson = await fs.readFile(path.join(logs, 'main-hang.ndjson'), 'utf8');
      const records = readHangRecords(ndjson);
      const capture = captureForEpisode(records, receipt.main ?? {});
      const recovery = capture && records.find(record => record.kind === 'main-thread-hang-recovered' && record.lastHeartbeatAt === capture.lastHeartbeatAt);
      if (capture && recovery) {
        if (!PROFILE_FILE_RE.test(capture.profileFile ?? '')) throw new Error('busy banner probe inspector profile missing');
        const profileText = await fs.readFile(path.join(logs, capture.profileFile), 'utf8');
        const proof = assertBusyBannerProof({ receipt, records, profile: JSON.parse(profileText), pid, expectedVersion });
        if (evidenceDir) {
          await fs.writeFile(path.join(evidenceDir, RECEIPT_FILE), JSON.stringify(receipt) + '\n', { mode: 0o600, flag: 'wx' });
          await fs.writeFile(path.join(evidenceDir, 'main-hang.ndjson'), ndjson, { mode: 0o600, flag: 'wx' });
          await fs.writeFile(path.join(evidenceDir, capture.profileFile), profileText, { mode: 0o600, flag: 'wx' });
        }
        return proof;
      }
    }
    if (Date.now() >= deadline) throw new Error('busy banner probe timed out waiting for renderer/profile evidence');
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

export async function runPackagedBusyBannerProbe(targetPath, {
  expectedVersion, evidenceDir, runSmoke = runPackagedSmoke, env = process.env, ...smokeOptions
} = {}) {
  if (!VERSION_RE.test(expectedVersion ?? '') || typeof evidenceDir !== 'string' || !path.isAbsolute(evidenceDir)) throw new Error('busy banner probe requires expected version and absolute artifact directory');
  await fs.mkdir(evidenceDir, { mode: 0o700 }); // Refuse an earlier acceptance receipt.
  const result = await runSmoke(targetPath, {
    ...smokeOptions, timeoutMs: 160_000,
    env: { ...env, [BUSY_BANNER_PROBE_ENV]: '1', [HANG_PROBE_ENV]: '0' },
    runtimeProbe: (child, { userData, signal }) => waitForBusyBannerProof(userData, { pid: child.pid, expectedVersion, evidenceDir, signal }),
    runtimeProbeTimeoutMs: 95_000,
  });
  const output = result?.output ?? '';
  const cleared = output.indexOf('[smoke] busy-banner: visible frames and automatic recovery proven');
  if (result?.runtimeProof?.schema !== 'nexus.busy-banner-acceptance/v1' || result.code !== 0 || cleared < 0 ||
      output.indexOf('[smoke] functional-ready') <= cleared || result.treeProof?.ok !== true ||
      !Array.isArray(result.processTreeProof?.orphans) || result.processTreeProof.orphans.length || result.shutdownMode !== 'graceful' ||
      !output.includes('[smoke] shutdown-complete: physical PTY inventory proven')) throw new Error('busy banner acceptance lacks recovered functional smoke and clean graceful exit');
  const proof = { ...result.runtimeProof, functionalSmokeAfterRecovery: true, processTreesClean: true, shutdownMode: 'graceful' };
  await fs.writeFile(path.join(evidenceDir, 'acceptance.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(`[smoke] busyBannerProof ${JSON.stringify(proof)}\n`);
  return proof;
}
