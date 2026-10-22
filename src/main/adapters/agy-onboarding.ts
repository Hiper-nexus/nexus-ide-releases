import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BoundSpawnAuthority } from '../orch/spawn-authority';
import { requiresSpawnGate } from '../orch/spawn-home-policy';

export const AGY_ONBOARDING_FILE = 'antigravity-cli/cache/onboarding.json';
export const AGY_CONSENT_MAX_BYTES = 64 * 1024;
export type AgyOnboardingFlow = 'consumer' | 'enterprise' | 'unknown';
export type AgyOnboardingReadiness = 'complete' | 'pending' | 'unknown';
type JsonRecord = Record<string, unknown>;
type ReadResult = { raw: string; json: JsonRecord | null; stat: fs.Stats };

export class AgyOnboardingPendingError extends Error {
  readonly code = 'onboarding_pending';
  constructor() {
    // Prefix survives callers that currently forward only Error.message.
    super('onboarding_pending: conclua o onboarding do Antigravity no pane do operador; termos e coleta de dados não foram aceitos pelo Nexus.');
    this.name = 'AgyOnboardingPendingError';
  }
}

function entry(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new AgyOnboardingPendingError(); }
}

/** These are fixed relative paths, never caller/model destinations. */
function scopedFile(root: string, relative: string, create = false): string | null {
  if (!path.isAbsolute(root)) throw new AgyOnboardingPendingError();
  let current = path.resolve(root);
  const rootStat = entry(current);
  if (!rootStat) return null;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AgyOnboardingPendingError();
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    let stat = entry(current);
    if (!stat && create) { fs.mkdirSync(current, { mode: 0o700 }); stat = entry(current); }
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AgyOnboardingPendingError();
  }
  return path.join(current, path.basename(relative));
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: fs.Stats, b: fs.Stats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function readBytes(fd: number, size: number): Buffer | null {
  if (size > AGY_CONSENT_MAX_BYTES) return null;
  const buffer = Buffer.alloc(size + 1);
  let bytes = 0;
  while (bytes < buffer.length) {
    const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
    if (n === 0) break;
    bytes += n;
  }
  return bytes === size ? buffer.subarray(0, bytes) : null;
}

/** Bounded descriptor read: never a FIFO/device, symlink or unbounded JSON. */
function read(file: string): ReadResult | null {
  const before = entry(file);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.size > AGY_CONSENT_MAX_BYTES) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !unchanged(before, stat) || stat.size > AGY_CONSENT_MAX_BYTES) return null;
    const buffer = readBytes(fd, stat.size);
    const after = entry(file);
    if (!buffer || !after || !unchanged(stat, fs.fstatSync(fd)) || !unchanged(stat, after)) return null;
    const raw = buffer.toString('utf8');
    if (!Buffer.from(raw, 'utf8').equals(buffer)) return null;
    let json: JsonRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as JsonRecord;
    } catch { /* Corrupt local preferences remain local; never replace with defaults. */ }
    return { raw, json, stat };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Legacy SETTINGS links are read-only here; only the selected source is allowed. */
function readSettings(file: string, source: string | null): ReadResult | null {
  const before = entry(file);
  if (!before) return null;
  if (!before.isSymbolicLink() && before.isFile() && before.nlink === 1) return read(file);
  if (!source) throw new AgyOnboardingPendingError();
  const data = read(source);
  if (!data) throw new AgyOnboardingPendingError();
  if (before.isSymbolicLink()) {
    const destination = path.resolve(path.dirname(file), fs.readlinkSync(file));
    if (path.toNamespacedPath(destination) !== path.toNamespacedPath(source)) throw new AgyOnboardingPendingError();
  } else if (!before.isFile()) throw new AgyOnboardingPendingError();
  const targetStat = fs.statSync(file);
  const after = entry(file);
  const sourceAfter = entry(source);
  if (!after || !sourceAfter || !unchanged(before, after) || !unchanged(data.stat, targetStat) || !unchanged(data.stat, sourceAfter)) {
    throw new AgyOnboardingPendingError();
  }
  return data;
}

function completed(json: JsonRecord | null, flow: Exclude<AgyOnboardingFlow, 'unknown'>): boolean {
  if (!json) return false;
  const flags = ['onboardingComplete', 'consumerOnboardingComplete', 'enterpriseOnboardingComplete'];
  if (flags.some(key => Object.hasOwn(json, key) && typeof json[key] !== 'boolean')) return false;
  // AGY 1.4.5 backend.OnboardingStatus.IsComplete: legacy marker applies to
  // consumer, never to enterprise. Telemetry is deliberately not consulted.
  const consumer = json.onboardingComplete === true || json.consumerOnboardingComplete === true;
  const enterprise = json.enterpriseOnboardingComplete === true;
  return flow === 'consumer' ? consumer : enterprise;
}

function allFalseProgress(json: JsonRecord | null): boolean {
  const flags = ['onboardingComplete', 'consumerOnboardingComplete', 'enterpriseOnboardingComplete'];
  return json !== null && Object.keys(json).length === flags.length && flags.every(key => json[key] === false);
}

/**
 * In-place repair of CLI progress ONLY, never settings/consent preferences.
 * The FD pins the old inode across pathname rename. This is NOT an atomic
 * transaction or CAS against an external writer modifying the same inode.
 */
function healPendingCache(source: string, target: string): void {
  const pending = read(target);
  if (!pending || !allFalseProgress(pending.json)) return;
  const proof = read(source);
  if (!proof || (!completed(proof.json, 'consumer') && !completed(proof.json, 'enterprise'))) return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const checkPath = (): fs.Stats => {
      const stat = fs.fstatSync(fd!);
      const atPath = entry(target);
      if (!stat.isFile() || stat.nlink !== 1 || !sameFile(pending.stat, stat) || !atPath ||
          atPath.isSymbolicLink() || !atPath.isFile() || atPath.nlink !== 1 || !unchanged(stat, atPath)) throw new AgyOnboardingPendingError();
      return stat;
    };
    const opened = checkPath();
    if (!unchanged(pending.stat, opened) || !readBytes(fd, opened.size)?.equals(Buffer.from(pending.raw, 'utf8'))) throw new AgyOnboardingPendingError();
    const sourceNow = read(source);
    if (!sourceNow || !unchanged(proof.stat, sourceNow.stat) || sourceNow.raw !== proof.raw ||
        !unchanged(opened, checkPath())) throw new AgyOnboardingPendingError();
    const bytes = Buffer.from(proof.raw, 'utf8');
    // One bounded write; stop on a partial write instead of retrying blindly.
    if (fs.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new AgyOnboardingPendingError();
    const written = checkPath();
    const expected = Buffer.concat([bytes, Buffer.from(pending.raw, 'utf8').subarray(bytes.length)]);
    if (!readBytes(fd, written.size)?.equals(expected) || !unchanged(written, checkPath())) throw new AgyOnboardingPendingError();
    fs.ftruncateSync(fd, bytes.length);
    fs.fsyncSync(fd);
    const finished = checkPath();
    if (!readBytes(fd, finished.size)?.equals(bytes) || !unchanged(finished, checkPath())) throw new AgyOnboardingPendingError();
  } catch { throw new AgyOnboardingPendingError(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Publish a copy, never a link back to the operator's preferences. */
function publish(file: string, raw: string): void {
  const tmp = path.join(path.dirname(file), `.agy-consent-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(fd, raw); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // Atomic, no-clobber publication: an independently created local choice wins.
    // There is deliberately NO replace-existing path: stat + rename is not CAS.
    try { fs.linkSync(tmp, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } catch { throw new AgyOnboardingPendingError(); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AgyOnboardingPendingError(); }
  }
}

/** Called only with the exact sourceHome Main selected for this account. */
export function projectAgyConsentState(sourceHome: string, providerHome: string): string[] {
  const linkedSettingsReadPaths: string[] = [];
  for (const relative of ['settings.json', 'antigravity-cli/settings.json', AGY_ONBOARDING_FILE]) {
    const source = scopedFile(sourceHome, relative);
    const target = scopedFile(providerHome, relative, true);
    if (!target) throw new AgyOnboardingPendingError();
    const existing = entry(target);
    const sourceStat = source ? entry(source) : undefined;
    if (existing) {
      if (relative !== AGY_ONBOARDING_FILE) {
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1) {
          if (!readSettings(target, source)) throw new AgyOnboardingPendingError();
          linkedSettingsReadPaths.push(source!);
        }
        // Independent local preferences always win; never relink or write them.
      } else {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new AgyOnboardingPendingError();
        if (source) healPendingCache(source, target);
      }
      continue;
    }
    if (!source) continue;
    const data = read(source);
    if (relative === AGY_ONBOARDING_FILE) {
      // A present cache outranks legacy settings even when pending/corrupt.
      // Preserve its exact evidence; omitting it could revive stale legacy true.
      if (data) publish(target, data.raw);
      else if (sourceStat) throw new AgyOnboardingPendingError();
      continue;
    }
    if (!data?.json) {
      // A present but unreadable preference may contain an opt-out. Dropping it
      // while importing completion would silently restore provider defaults.
      if (sourceStat) throw new AgyOnboardingPendingError();
      continue;
    }
    publish(target, data.raw);
  }
  return linkedSettingsReadPaths;
}

type OnboardingAuthority = Pick<BoundSpawnAuthority, 'source'> & {
  readonly context: {
    readonly role?: 'user' | 'worker' | 'orchestrator';
    readonly allowedTools?: readonly string[] | null;
    readonly allowedSkills?: readonly string[] | null;
    readonly operatorOpened?: boolean;
    readonly operatorParentSessionId?: string;
    readonly missionId?: string;
  } | null;
};

export function requiresAgyOnboardingProof(authority: OnboardingAuthority): boolean {
  const context = authority.context;
  if (authority.source === 'direct-user' && context === null) return false;
  if (context?.operatorOpened === true && !context.operatorParentSessionId) return false;
  if (!context?.role) return true;
  return requiresSpawnGate(context) || context?.role === 'worker' || Boolean(context?.missionId || context?.operatorParentSessionId);
}

/** Readiness only: an unknown backend flow is left to the CLI, never inferred. */
export function assertNoKnownAgyOnboardingBlock(
  providerHome: string,
  authority: OnboardingAuthority,
  flow: AgyOnboardingFlow = 'unknown',
  sourceHome?: string,
): Exclude<AgyOnboardingReadiness, 'pending'> {
  if (!requiresAgyOnboardingProof(authority)) return 'unknown';
  let readiness: AgyOnboardingReadiness = 'pending';
  try {
    let legacy: JsonRecord | null = null;
    for (const relative of ['settings.json', 'antigravity-cli/settings.json']) {
      const preference = scopedFile(providerHome, relative);
      if (preference && entry(preference)) {
        const data = readSettings(preference, sourceHome ? scopedFile(sourceHome, relative) : null);
        if (!data?.json) throw new AgyOnboardingPendingError();
        if (relative === 'antigravity-cli/settings.json') legacy = { onboardingComplete: data.json.onboardingComplete ?? false };
      }
    }
    const file = scopedFile(providerHome, AGY_ONBOARDING_FILE);
    // A present cache (even corrupt) takes precedence over legacy settings.
    const record = file && entry(file) ? read(file)?.json ?? null : legacy;
    if (flow === 'unknown') {
      if (completed(record, 'consumer') || completed(record, 'enterprise')) readiness = 'unknown';
    } else if (completed(record, flow)) readiness = 'complete';
  } catch { /* Unsafe/unreadable files still fail closed, without changing them. */ }
  if (readiness === 'pending') throw new AgyOnboardingPendingError();
  return readiness;
}
