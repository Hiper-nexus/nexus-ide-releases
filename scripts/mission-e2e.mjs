#!/usr/bin/env node
// F-971: `npm run test:mission-e2e` — a missão inteira de ponta a ponta
// (src/main/orch/mission-e2e.test.ts) com o Main real, PTY real e uma CLI de
// agente falsa. O gate de release roda este script; exit ≠ 0 bloqueia a
// publicação. Ver docs/MISSION-E2E.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MISSION_E2E_TEST = 'src/main/orch/mission-e2e.test.ts';

/** Ambiente do E2E: nada da admissão/MCP de um pane do Nexus vaza para o "Main" do teste. */
export function missionE2EEnvironment(source = process.env) {
  const env = { ...source, NEXUS_MISSION_E2E: '1' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NEXUS_HEAVY_') || key.startsWith('NEXUS_SHIM_') || key === 'NODE_OPTIONS' ||
        key === 'BASH_ENV' || key === 'ZDOTDIR' || key === 'NEXUS_MCP_URL' || key === 'NEXUS_MCP_TOKEN' ||
        key === 'NEXUS_GATE_URL' || key === 'NEXUS_GATE_TOKEN') delete env[key];
  }
  return env;
}

/**
 * O supervisor de PTY do macOS recusa herdar a responsabilidade de um pane do
 * Nexus (F-715): dentro de um pane o E2E falharia por ambiente, não por
 * regressão. Recusa com a saída em vez de um vermelho enganoso.
 */
export function missionE2EEnvironmentProblem(source = process.env, platform = process.platform) {
  if (platform === 'darwin' && (source.NEXUS_PANE_ID || source.NEXUS_PANE_KEY)) {
    return 'rode fora de um pane do Nexus (job launchd ou terminal comum): o supervisor de PTY do macOS recusa a responsabilidade herdada de um pane (F-715)';
  }
  if (platform === 'win32') return 'o E2E de missão roda em macOS e Linux';
  return null;
}

export function parseMissionE2EArgs(argv) {
  const options = { receipt: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--receipt' && argv[index + 1]) options.receipt = path.resolve(argv[++index]);
    else throw new Error(`uso: mission-e2e.mjs [--receipt <arquivo.json>] (argumento inesperado: ${argv[index]})`);
  }
  return options;
}

function main() {
  const options = parseMissionE2EArgs(process.argv.slice(2));
  const problem = missionE2EEnvironmentProblem();
  if (problem) {
    process.stderr.write(`[mission-e2e] ${problem}\n`);
    process.exit(3);
  }
  const natives = spawnSync(process.execPath, [path.join(root, 'scripts/check-node-natives.mjs')], { cwd: root, stdio: 'inherit' });
  if (natives.status !== 0) {
    process.stderr.write('[mission-e2e] módulos nativos fora do ABI deste Node (rode `npm run rebuild:node`)\n');
    process.exit(natives.status ?? 1);
  }
  const startedAt = new Date();
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', MISSION_E2E_TEST, '--maxWorkers=1'], {
    cwd: root, env: missionE2EEnvironment(), stdio: 'inherit', timeout: 15 * 60_000,
  });
  const status = result.status ?? 1;
  if (options.receipt) {
    fs.mkdirSync(path.dirname(options.receipt), { recursive: true });
    fs.writeFileSync(options.receipt, `${JSON.stringify({
      schemaVersion: 1, test: MISSION_E2E_TEST, status: status === 0 ? 'pass' : 'fail', exitCode: status,
      signal: result.signal ?? null, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      node: process.version, platform: process.platform, arch: process.arch,
    }, null, 2)}\n`);
  }
  process.stdout.write(`[mission-e2e] ${status === 0 ? 'VERDE' : 'VERMELHO'} (exit ${status})\n`);
  process.exit(status);
}

const isDirectRun = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false;
if (isDirectRun) main();
