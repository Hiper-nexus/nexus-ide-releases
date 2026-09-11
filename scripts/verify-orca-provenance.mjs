#!/usr/bin/env node
/**
 * Mechanical honesty check for every third_party/provenance/orca-*.json
 * ledger against a local Git clone containing every ledger commit. The first
 * ledger began at 143c36e; resync waves add orca-<pin>[-<wave>].json ledgers
 * whose entries supersede same-nexusPath entries in earlier ledgers.
 *
 * Rules:
 * - status "superseded": hash not re-checked (history); a live entry for the
 *     same nexusPath pinned to supersededBy must exist
 * - originalPath starts with "(concept)":
 *     originalSha256 === sha256(nexus file in repo)
 * - otherwise (copied/adapted with real pin path):
 *     `<entry.upstreamCommit>:<originalPath>` must be a Git blob AND
 *     originalSha256 === sha256(blob)
 * - every source file with an "Adapted from stablyai/orca @ <sha>" header
 *     must have a ledger nexusPath entry pinned to that exact commit
 *
 * Env: ORCA_PIN_DIR (required), REPO_ROOT (default cwd)
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.env.REPO_ROOT || process.cwd();
const LEDGER_DIR = join(REPO, 'third_party/provenance');
const LEDGERS = existsSync(LEDGER_DIR)
  ? readdirSync(LEDGER_DIR)
      .filter((name) => /^orca-[a-f0-9]+(-[a-z0-9-]+)?\.json$/.test(name))
      .sort()
      .map((name) => join(LEDGER_DIR, name))
  : [];
const pinDir = process.env.ORCA_PIN_DIR;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures += 1;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

if (LEDGERS.length === 0) {
  fail(`no orca-*.json ledgers found in ${LEDGER_DIR}`);
  process.exit(1);
}
if (!pinDir || !existsSync(pinDir)) {
  fail(`ORCA_PIN_DIR missing or not a directory: ${pinDir}`);
  process.exit(1);
}

const files = LEDGERS.flatMap(
  (ledgerPath) => JSON.parse(readFileSync(ledgerPath, 'utf8')).files || [],
);
const nexusPaths = new Set(files.map((e) => e.nexusPath));
const entriesByNexusPath = new Map();
for (const entry of files) {
  const list = entriesByNexusPath.get(entry.nexusPath) ?? [];
  list.push(entry);
  entriesByNexusPath.set(entry.nexusPath, list);
}
let checked = 0;

for (const e of files) {
  checked += 1;
  if (e.status === 'superseded') {
    // History, not authority: the entry that replaced it (same nexusPath,
    // pinned to supersededBy) is the one whose hash must hold. A superseded
    // "(concept)" entry would otherwise fail as soon as the file evolves.
    const successor = (entriesByNexusPath.get(e.nexusPath) ?? []).some(
      (other) =>
        other !== e &&
        other.status !== 'superseded' &&
        (!e.supersededBy || other.upstreamCommit === e.supersededBy),
    );
    if (!successor) {
      fail(
        `superseded entry ${e.nexusPath} has no live successor pinned to ${e.supersededBy ?? '(unspecified)'}`,
      );
    }
    continue;
  }
  const op = (e.originalPath || '').trim();
  const nexusAbs = join(REPO, e.nexusPath);
  if (!existsSync(nexusAbs) || !lstatSync(nexusAbs).isFile()) {
    fail(`nexusPath missing or not a file: ${e.nexusPath}`);
    continue;
  }
  const nexusSha = sha256(readFileSync(nexusAbs));

  if (op.startsWith('(concept)')) {
    if (e.originalSha256 !== nexusSha) {
      fail(
        `concept entry ${e.nexusPath}: originalSha256 is not sha256(nexus file)\n  want ${nexusSha}\n  got  ${e.originalSha256}`,
      );
    }
    continue;
  }

  if (!op) {
    fail(`entry ${e.nexusPath}: empty originalPath (use pin path or "(concept) …")`);
    continue;
  }

  const commit = String(e.upstreamCommit ?? '');
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    op.startsWith('/') ||
    op.includes('\\') ||
    op.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(
      `entry ${e.nexusPath}: unsafe commit or upstream path`,
    );
    continue;
  }
  let pinBlob;
  try {
    pinBlob = execFileSync(
      'git',
      ['-C', pinDir, 'show', `${commit}:${op}`],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    fail(
      `entry ${e.nexusPath}: ${commit}:${op} is not a readable Git blob`,
    );
    continue;
  }
  const pinSha = sha256(pinBlob);
  if (e.originalSha256 !== pinSha) {
    fail(
      `entry ${e.nexusPath}: originalSha256 does not match pin file ${op}\n  want ${pinSha}\n  got  ${e.originalSha256}`,
    );
  }
}

const headerRe = /Adapted from stablyai\/orca @ ([a-f0-9]{40})/;
for (const root of ['src', 'scripts'].map((r) => join(REPO, r))) {
  for (const abs of walk(root)) {
    const text = readFileSync(abs, 'utf8').slice(0, 1200);
    const match = headerRe.exec(text);
    if (!match) continue;
    const rel = relative(REPO, abs).replace(/\\/g, '/');
    if (!nexusPaths.has(rel)) {
      fail(`file has ORCA header but no ledger nexusPath: ${rel}`);
    } else if (
      !(entriesByNexusPath.get(rel) ?? []).some(
        (entry) => entry.upstreamCommit === match[1],
      )
    ) {
      fail(`file ORCA header commit is absent from ledger: ${rel} @ ${match[1]}`);
    }
  }
}

if (failures > 0) {
  console.error(`\nprovenance verify FAILED: ${failures} issue(s); ${checked} entries scanned`);
  process.exit(1);
}
console.log(
  `PASS provenance verify: ${checked} entries across ${LEDGERS.length} ledger(s) honest; header coverage OK; pin=${pinDir}`,
);
process.exit(0);
