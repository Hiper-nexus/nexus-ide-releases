import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { parse } from 'smol-toml';
import { afterEach, expect, it } from 'vitest';
import { codexPrivateHookArgs, installCodexPrivateHookTrust } from './codex-private-hook-trust';
import { mergeCodexHookTrustState } from '../agent-hooks/codex-hook-trust';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-private-hooks-'));
  roots.push(root);
  const home = path.join(root, 'private'), native = path.join(root, 'native');
  fs.mkdirSync(home); fs.mkdirSync(native);
  fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks=true\n');
  return { root, home, native };
}

it('refuses the native profile, linked homes/configs, and pre-existing foreign hook files', () => {
  const { root, home, native } = fixture();
  fs.writeFileSync(path.join(native, 'config.toml'), '# native untouched\n');
  expect(() => installCodexPrivateHookTrust(native, native)).toThrow('private provider home');
  const linked = path.join(root, 'linked');
  fs.symlinkSync(home, linked, 'junction');
  expect(() => installCodexPrivateHookTrust(linked, native)).toThrow('private provider home');
  fs.unlinkSync(path.join(home, 'config.toml'));
  fs.symlinkSync(path.join(native, 'config.toml'), path.join(home, 'config.toml'));
  expect(() => installCodexPrivateHookTrust(home, native)).toThrow('private regular config');
  fs.unlinkSync(path.join(home, 'config.toml'));
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  fs.symlinkSync(path.join(native, 'config.toml'), path.join(home, 'hooks.json'));
  expect(() => installCodexPrivateHookTrust(home, native)).toThrow('already exist');
  expect(fs.readFileSync(path.join(native, 'config.toml'), 'utf8')).toBe('# native untouched\n');
});

it('retains Windows path trust keys with spaces through TOML without trusting another entry', () => {
  const key = 'C:\\Nexus data\\codex\\private\\hooks.json:stop:0:1';
  const config = parse(mergeCodexHookTrustState('[hooks.state."foreign"]\ntrusted_hash="sha256:foreign"\n',
    [{ key, trustedHash: 'sha256:generated' }]));
  const state = (config.hooks as { state: Record<string, { trusted_hash: string }> }).state;
  expect(state[key]?.trusted_hash).toBe('sha256:generated');
  expect(state.foreign?.trusted_hash).toBe('sha256:foreign');
});

let modernCodex = false;
try { modernCodex = /codex-cli 0\.16\d\./.test(execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 })); }
catch { /* Optional local protocol proof; unit tests stay available in CI without Codex. */ }

it.skipIf(!modernCodex)('Codex hooks/list trusts every Nexus hook, leaves foreign hooks untrusted, and executes no commands', async () => {
  const { root, home, native } = fixture();
  const sentinel = path.join(root, 'must-not-exist');
  const foreignCommand = 'node -e "require(\'node:fs\').writeFileSync(process.env.NEXUS_HOOK_TEST_SENTINEL,\'executed\')"';
  fs.appendFileSync(path.join(home, 'config.toml'), `\n[[hooks.SessionEnd]]\n[[hooks.SessionEnd.hooks]]\ntype="command"\ncommand=${JSON.stringify(foreignCommand)}\n`);
  installCodexPrivateHookTrust(home, native);
  const args = codexPrivateHookArgs();
  expect(args).not.toContain('--dangerously-bypass-hook-trust');
  const response = await new Promise<{ result: { data: Array<{ hooks: Array<{ command: string; trustStatus: string }>; errors: unknown[] }> } }>((resolve, reject) => {
    const child = spawn('codex', [...args, 'app-server', '--stdio'], {
      cwd: home, env: { ...process.env, CODEX_HOME: home, NEXUS_HOOK_TEST_SENTINEL: sentinel }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex hooks/list timeout')); }, 8000);
    let completed = false, buffer = '';
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', () => { clearTimeout(timer); if (!completed) reject(new Error('Codex exited before hooks/list')); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [home] } })}\n`);
        }
        if (message.id === 2) { completed = true; clearTimeout(timer); child.kill(); resolve(message); }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'nexus-hook-trust-test', version: '1' }, capabilities: { experimentalApi: true } } })}\n`);
  });
  const listing = response.result.data[0]!;
  expect(listing.errors).toEqual([]);
  const foreign = listing.hooks.find((hook) => hook.command === foreignCommand);
  expect(foreign?.trustStatus).toBe('untrusted');
  const generated = listing.hooks.filter((hook) => hook !== foreign);
  // 9 hooks de status/portões + o broker de aprovação no PermissionRequest
  // (PRV-02): a confiança é recalculada dos comandos gerados, sem revisão.
  expect(generated).toHaveLength(10);
  expect(generated.every((hook) => hook.trustStatus === 'trusted')).toBe(true);
  expect(generated.some((hook) => hook.command.includes('NEXUS_HOOK_PERMISSION_URL'))).toBe(true);
  expect(fs.existsSync(sentinel)).toBe(false);
});
