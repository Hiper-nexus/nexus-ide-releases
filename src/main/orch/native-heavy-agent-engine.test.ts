import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const childProcessHook = path.resolve('resources/heavy-command/child-process.cjs');
const PROMPT = 'rode npm run typecheck e npx vitest antes de entregar; use node para scripts';

/** Pacote falso no formato do @openai/codex: lançador Node + motor nativo no vendor. */
function fakeAgentPackage() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agent-engine-')));
  const pkg = path.join(root, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  const entry = path.join(pkg, 'bin', 'codex.js');
  fs.writeFileSync(entry, [
    `require(${JSON.stringify(childProcessHook)})();`,
    `const r = require('node:child_process').spawnSync(process.argv[2], [${JSON.stringify(PROMPT)}], { encoding: 'utf8' });`,
    `process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));`,
  ].join('\n'));
  const engine = (dir: string) => {
    const file = path.join(dir, 'codex');
    fs.writeFileSync(file, '#!/bin/sh\necho "ENGINE_RAN $#"\n', { mode: 0o755 });
    return file;
  };
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  return { entry, engineInPackage: engine(path.join(pkg, 'vendor')), engineOutside: engine(outside) };
}

function launch(entry: string, engine: string, agentEntry: string) {
  const run = spawnSync(process.execPath, [entry, engine], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), NEXUS_HEAVY_AGENT_ENTRY: agentEntry },
    timeout: 20_000,
  });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as { status: number; stdout: string; stderr: string };
}

describe.skipIf(process.platform === 'win32')('heavy-command hook × motor nativo da CLI do agente', () => {
  it('o lançador do agente inicia o próprio motor sem virar comando pesado, mesmo com typecheck no prompt', () => {
    const { entry, engineInPackage } = fakeAgentPackage();
    const result = launch(entry, engineInPackage, entry);
    expect(result.stdout).toBe('ENGINE_RAN 1\n');
    expect(result.stderr).not.toContain('Heavy command not started');
  });

  it('binário fora do pacote do agente continua classificado pelo comando', () => {
    const { entry, engineOutside } = fakeAgentPackage();
    const result = launch(entry, engineOutside, entry);
    expect(result.stdout).not.toContain('ENGINE_RAN');
    expect(result.stderr).toContain('Heavy command not started');
  });

  it('processo que não é o entry do agente não ganha a isenção', () => {
    const { entry, engineInPackage } = fakeAgentPackage();
    const result = launch(entry, engineInPackage, path.join(os.tmpdir(), 'outro-agente.js'));
    expect(result.stdout).not.toContain('ENGINE_RAN');
    expect(result.stderr).toContain('Heavy command not started');
  });
});
