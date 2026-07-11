#!/usr/bin/env node
/**
 * Fail if F3 agent-runtime symbols lack a non-test production importer
 * reachable from agent-runtime-bridge / window / hook-ingest / main.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = process.env.REPO_ROOT || process.cwd();

const REQUIRED = [
  {
    symbol: 'mapAgentHookStatusToPaneSession',
    define: 'src/main/agent-hooks/agent-hook-activity-mapper.ts',
  },
  {
    symbol: 'AgentAwakeService',
    define: 'src/main/agent-awake-service.ts',
  },
  {
    symbol: 'shouldRecordProcessGoneCrash',
    define: 'src/main/crash-reporting/process-gone-classification.ts',
  },
  {
    symbol: 'recordCrashBreadcrumb',
    define: 'src/main/crash-reporting/crash-breadcrumb-store.ts',
  },
  {
    symbol: 'CrashReportStore',
    define: 'src/main/crash-reporting/crash-report-store.ts',
  },
  {
    symbol: 'handleRenderProcessGone',
    define: 'src/main/agent-runtime/agent-runtime-bridge.ts',
  },
  {
    symbol: 'publishAgentHookActivity',
    define: 'src/main/agent-runtime/agent-runtime-bridge.ts',
  },
  {
    symbol: 'ingestAgentHookStatus',
    define: 'src/main/agent-hooks/hook-ingest.ts',
  },
];

const ANCHOR_FILES = [
  'src/main/agent-runtime/agent-runtime-bridge.ts',
  'src/main/agent-hooks/hook-ingest.ts',
  'src/main/window.ts',
  'src/main/main.ts',
];

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.includes('.test.')) acc.push(p);
  }
  return acc;
}

function read(rel) {
  return readFileSync(join(REPO, rel), 'utf8');
}

let failures = 0;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failures += 1;
}

// Anchors must exist and reference symbols
const windowSrc = read('src/main/window.ts');
if (!windowSrc.includes('handleRenderProcessGone')) {
  fail('window.ts must call handleRenderProcessGone');
}
const mainSrc = read('src/main/main.ts');
if (!mainSrc.includes('getAgentAwakeService')) {
  fail('main.ts must start getAgentAwakeService');
}
const bridgeSrc = read('src/main/agent-runtime/agent-runtime-bridge.ts');
for (const s of [
  'mapAgentHookStatusToPaneSession',
  'AgentAwakeService',
  'shouldRecordProcessGoneCrash',
  'recordCrashBreadcrumb',
  'CrashReportStore',
  'publishSessionActivityState',
]) {
  if (!bridgeSrc.includes(s)) fail(`agent-runtime-bridge.ts missing ${s}`);
}
const ingestSrc = read('src/main/agent-hooks/hook-ingest.ts');
if (!ingestSrc.includes('publishAgentHookActivity')) {
  fail('hook-ingest must call publishAgentHookActivity');
}
if (!ingestSrc.includes('agent-hook-listener')) {
  fail('hook-ingest must import agent-hook-listener');
}

// Each required symbol must appear in at least one non-test file other than its define
const allProd = walk(join(REPO, 'src/main'));
for (const req of REQUIRED) {
  const importers = [];
  for (const abs of allProd) {
    const rel = relative(REPO, abs).replace(/\\/g, '/');
    if (rel === req.define) continue;
    const text = readFileSync(abs, 'utf8');
    if (text.includes(req.symbol)) importers.push(rel);
  }
  if (importers.length === 0) {
    fail(`${req.symbol} has no non-test production importer (define=${req.define})`);
  } else {
    console.log(`OK ${req.symbol} ← ${importers.join(', ')}`);
  }
}

// Anchor files must exist
for (const a of ANCHOR_FILES) {
  if (!existsSync(join(REPO, a))) fail(`missing anchor ${a}`);
}

if (failures) {
  console.error(`\nwiring verify FAILED: ${failures} issue(s)`);
  process.exit(1);
}
console.log('PASS agent-runtime wiring verify');
process.exit(0);
