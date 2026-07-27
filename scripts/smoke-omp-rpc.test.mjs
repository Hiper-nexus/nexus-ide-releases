import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const suite = process.platform === 'darwin' ? describe : describe.skip;
const fixtures = [];

function makeFakeOmp() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-omp-smoke-test-'));
  fixtures.push(root);
  const transcript = path.join(root, 'rpc-frames.ndjson');
  const binary = path.join(root, 'omp');
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) {
  process.stdout.write('Oh My Pi 17.0.4\\n');
  process.exit(0);
}
if (!process.argv.includes('rpc-ui')) process.exit(64);
const transcript = ${JSON.stringify(transcript)};
const write = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
write({ type: 'ready' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  fs.appendFileSync(transcript, line + '\\n');
  const frame = JSON.parse(line);
  if (frame.type === 'set_host_tools') {
    write({
      id: frame.id,
      type: 'response',
      command: frame.type,
      success: true,
      data: { toolNames: frame.tools.map((tool) => tool.name) },
    });
    return;
  }
  if (frame.type === 'get_state') {
    write({
      id: frame.id,
      type: 'response',
      command: frame.type,
      success: true,
      data: {
        model: { provider: 'local-smoke', id: 'no-provider' },
        isStreaming: false,
        isCompacting: false,
        sessionId: 'fake-local-session',
      },
    });
    return;
  }
  write({
    id: frame.id,
    type: 'response',
    command: frame.type,
    success: false,
    error: 'unexpected command',
  });
});
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return { binary, transcript };
}

function runSmoke(binary) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'smoke:omp-rpc', '--silent'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        NEXUS_OMP_BIN: binary,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('smoke:omp-rpc não encerrou sozinho em 20 segundos'));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

suite('smoke:omp-rpc local lifecycle', () => {
  it(
    'rebuilds the helper and exits only after a prompt-free RPC handshake and proven teardown',
    async () => {
      const { binary, transcript } = makeFakeOmp();
      const execution = await runSmoke(binary);

      expect(
        execution,
        `stdout:\n${execution.stdout}\nstderr:\n${execution.stderr}`,
      ).toMatchObject({ code: 0, signal: null });
      const payloadLine = execution.stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith('{"ok":true'));
      expect(payloadLine).toBeDefined();
      expect(JSON.parse(payloadLine)).toMatchObject({
        ok: true,
        version: '17.0.4',
        state: 'idle',
        model: { provider: 'local-smoke', id: 'no-provider' },
        promptSent: false,
        realCredentialInherited: false,
        teardownProven: true,
      });
      expect(execution.stderr).not.toMatch(
        /\[smoke:omp-rpc\]|bootstrap falhou|processo omp encerrou/iu,
      );

      const outboundTypes = readFileSync(transcript, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).type);
      expect(outboundTypes).toEqual(['set_host_tools', 'get_state']);
      expect(outboundTypes).not.toContain('prompt');
    },
    30_000,
  );
});
