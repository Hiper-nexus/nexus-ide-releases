#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(scripts);
const option = process.argv.indexOf('--output-dir');
if (option >= 0 && !process.argv[option + 1]) throw new Error('--output-dir requires a path');
const output = path.resolve(repo, option >= 0 ? process.argv[option + 1] : 'release-artifacts/browser-smoke');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-browser-functional-'));
fs.mkdirSync(output, { recursive: true });
for (const [entry, outfile] of [[path.join(repo, 'src/preload/browser-preload.ts'), 'preload.js'], [path.join(scripts, 'browser-functional-smoke-main.ts'), 'main.js']]) {
  await build({ entryPoints: [entry], outfile: path.join(temporary, outfile), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
}
fs.copyFileSync(path.join(scripts, 'browser-functional-smoke.fixture.html'), path.join(temporary, 'fixture.html'));
const require = createRequire(import.meta.url);
const electron = require('electron');
const noSandbox = process.getuid?.() === 0 || process.env.NEXUS_BROWSER_SMOKE_NO_SANDBOX === '1';
const childEnv = { ...process.env, NEXUS_BROWSER_SMOKE_OUTPUT: output };
delete childEnv.ELECTRON_RUN_AS_NODE;
const args = [...(noSandbox ? ['--no-sandbox'] : []), '--disable-gpu', '--disable-dev-shm-usage', path.join(temporary, 'main.js')];
// This launch flag is fixture-only; app production configuration is unchanged.
const child = spawn(electron, args, { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; process.stdout.write(data); });
child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
clearTimeout(timer);
fs.writeFileSync(path.join(output, 'stdout.log'), stdout);
fs.writeFileSync(path.join(output, 'stderr.log'), stderr);
fs.writeFileSync(path.join(output, 'launch.json'), JSON.stringify({ ...result, noSandboxLaunch: noSandbox, display: Boolean(process.env.DISPLAY), temporaryFixture: true }, null, 2));
if (result.code !== 0) {
  console.error('Browser functional smoke failed. See report.json (if initialized), launch.json and stderr.log.');
  process.exitCode = 1;
}
