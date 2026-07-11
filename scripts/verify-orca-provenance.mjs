#!/usr/bin/env node
/**
 * Mechanical honesty check for third_party/provenance/orca-143c36e.json
 * against a local pin clone of stablyai/orca @ 143c36e.
 *
 * Rules:
 * - originalPath starts with "(concept)":
 *     originalSha256 === sha256(nexus file in repo)
 * - otherwise (copied/adapted with real pin path):
 *     pin file must exist as a file AND originalSha256 === sha256(pin file)
 * - every source file with "Adapted from stablyai/orca @ 143c36e…" header
 *     must have a ledger nexusPath entry
 *
 * Env: ORCA_PIN_DIR (required), REPO_ROOT (default cwd)
 */
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const PIN = '143c36e566483006fe54fa2716b019ec00599752';
const REPO = process.env.REPO_ROOT || process.cwd();
const LEDGER = join(REPO, 'third_party/provenance/orca-143c36e.json');
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

if (!existsSync(LEDGER)) {
  fail(`ledger missing: ${LEDGER}`);
  process.exit(1);
}
if (!pinDir || !existsSync(pinDir)) {
  fail(`ORCA_PIN_DIR missing or not a directory: ${pinDir}`);
  process.exit(1);
}

const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const files = ledger.files || [];
const nexusPaths = new Set(files.map((e) => e.nexusPath));
let checked = 0;

for (const e of files) {
  checked += 1;
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

  const pinFile = join(pinDir, op);
  if (!existsSync(pinFile) || !lstatSync(pinFile).isFile()) {
    fail(
      `entry ${e.nexusPath}: originalPath "${op}" is not a file in pin clone`,
    );
    continue;
  }
  const pinSha = sha256(readFileSync(pinFile));
  if (e.originalSha256 !== pinSha) {
    fail(
      `entry ${e.nexusPath}: originalSha256 does not match pin file ${op}\n  want ${pinSha}\n  got  ${e.originalSha256}`,
    );
  }
}

const headerRe = new RegExp(
  String.raw`Adapted from stablyai/orca @ ${PIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
);
for (const root of ['src', 'scripts'].map((r) => join(REPO, r))) {
  for (const abs of walk(root)) {
    const text = readFileSync(abs, 'utf8').slice(0, 1200);
    if (!headerRe.test(text)) continue;
    const rel = relative(REPO, abs).replace(/\\/g, '/');
    if (!nexusPaths.has(rel)) {
      fail(`file has ORCA header but no ledger nexusPath: ${rel}`);
    }
  }
}

if (failures > 0) {
  console.error(`\nprovenance verify FAILED: ${failures} issue(s); ${checked} entries scanned`);
  process.exit(1);
}
console.log(
  `PASS provenance verify: ${checked} ledger entries honest; header coverage OK; pin=${pinDir}`,
);
process.exit(0);
