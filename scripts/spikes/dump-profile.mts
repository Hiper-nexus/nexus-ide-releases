import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { buildMacosSeatbeltPlan } from '../../src/main/runtime/process-sandbox.ts';
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
const runtime = path.join(os.homedir(), '.nexus', 'ephemeral', 'agy-native', 'rt');
fs.mkdirSync(runtime, { recursive: true });
const plan = buildMacosSeatbeltPlan({
  platform: 'darwin',
  executable: '/Users/cleofasrocha/.local/bin/agy',
  args: ['--print', 'x'],
  cwd: workspace, rootRealPath: workspace,
  sandboxDir: runtime, privateHome: runtime,
  processHome: os.homedir(),
  env: { PATH: process.env.PATH },
  readOnlyRoot: true, sandboxProfile: 'workspace-net',
  extraReadPaths: [path.join(os.homedir(), '.gemini')],
  extraWritePaths: [path.join(os.homedir(), '.gemini')],
}, '/usr/bin/sandbox-exec');
fs.writeFileSync('/tmp/agy-profile.sbpl', plan.args[1]);
console.log('wrote /tmp/agy-profile.sbpl');
