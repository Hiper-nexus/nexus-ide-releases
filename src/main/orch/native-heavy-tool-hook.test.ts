import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { claudeNativeHeavyHookCommand } from './native-heavy-tool-hook';
import { NativeHeavyCommands } from './native-heavy-command';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import type { AgentGateContext } from './gate';

const claude = process.env.NEXUS_TEST_CLAUDE_BIN ?? (process.env.PATH ?? '').split(path.delimiter).map((directory) => path.join(directory, 'claude')).find((file) => fs.existsSync(file));
const runNative = process.platform === 'darwin' && Boolean(claude);
function streamMessage(res: http.ServerResponse, model: string, content: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }) {
 res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
 const event = (name: string, value: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
 event('message_start', { type: 'message_start', message: { id: 'msg_finite', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
 if (content.type === 'tool_use') {
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: content.id, name: content.name, input: {} } });
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } });
 } else {
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } });
 }
 event('content_block_stop', { type: 'content_block_stop', index: 0 });
 event('message_delta', { type: 'message_delta', delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
 event('message_stop', { type: 'message_stop' }); res.end();
}

it.runIf(runNative)('real Claude native Bash receives same-shell admission before an absolute sh/make with NODE_OPTIONS stripped', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-real-claude-'));
 fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\t@printf done > command-ran\n');
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'claude-hook', checkoutId: 'finite', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-hook', sessionId: 'finite-hook-session', role: 'user', scope } as AgentGateContext;
 let cliPid = 0, cliAlive = true; const identity = {};
 const proof = new OwnedCommandProcesses((id) => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity } : null);
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const transitions: string[] = [];
 const native = new NativeHeavyCommands({ current: () => cliAlive, claim: (id, pid) => proof.claim(id, pid), probe: (id, claim) => proof.probe(id, claim), borrow: (id, claim, pid) => proof.borrow(id, claim, pid),
   acquire: async (request) => { const permit = await pool.acquire(request); transitions.push('grant'); return { id: permit.id, release: () => { transitions.push('release'); permit.release(); } }; } });
 let modelCalls = 0;
 const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (part) => { raw += part; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
   if (req.url === '/hook/heavy-command') {
    if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
    void native.admit(ctx, JSON.parse(raw)).then((result) => res.end(JSON.stringify(result))); return;
   }
   if (req.url?.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
   if (req.url?.startsWith('/v1/messages')) {
    const request = JSON.parse(raw); modelCalls++;
    if (modelCalls === 1) streamMessage(res, request.model, { type: 'tool_use', id: 'toolu_finite_make', name: 'Bash', input: { command: 'NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"', description: 'finite fixture only' } });
    else streamMessage(res, request.model, { type: 'text', text: 'finite fixture done' }); return;
   }
   res.writeHead(404); res.end('{}');
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address() as { port: number };
 const resources = path.join(process.cwd(), 'resources/heavy-command');
 const settings = path.join(root, 'settings.json');
 fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: claudeNativeHeavyHookCommand(), timeout: 5 }] }] } }));
 const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: root, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(root, 'securestorage'),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'finite-test-credential', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl' };
 delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.NODE_OPTIONS; delete env.BASH_ENV; delete env.ZDOTDIR;
 const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${port}"))`;
 const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, claude!, '-p', 'finite fixture', '--dangerously-skip-permissions', '--tools', 'Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', settings, '--output-format', 'json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
 cliPid = child.pid!; let stderr = '', stdout = ''; child.stderr.on('data', (part) => stderr += part); child.stdout.on('data', (part) => stdout += part);
 const exit = new Promise<number | null>((resolve) => child.once('close', (code) => { cliAlive = false; resolve(code); }));
 const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
 try {
  const code = await exit; expect(code, (stderr || stdout).slice(0, 2048)).toBe(0); expect(modelCalls).toBe(2);
  expect(fs.readFileSync(path.join(root, 'command-ran'), 'utf8')).toBe('done');
  await native.drain(); expect(transitions).toEqual(['grant', 'release']); expect(stdout).toContain('finite fixture done');
 } finally {
  clearTimeout(timer); child.kill('SIGTERM'); await exit; pool.close();
  await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
 }
}, 35_000);


it('native input transformation preserves fields and never grants permission or sends a bearer', () => {
 const resources = path.join(process.cwd(), 'resources/heavy-command');
 const input = { command: '/bin/sh -c "make"', timeout: 123, description: 'finite', run_in_background: true };
 const result = spawnSync(process.execPath, [path.join(resources, 'tool-hook.cjs')], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: input }),
   env: { NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1234/hook/heavy-command', NEXUS_GATE_TOKEN: 'finite-token', NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources } });
 expect(result.status).toBe(0);
 const value = JSON.parse(result.stdout).hookSpecificOutput;
 expect(value).not.toHaveProperty('permissionDecision');
 expect(value.updatedInput).toMatchObject({ timeout: 123, description: 'finite', run_in_background: true });
 expect(value.updatedInput.command.endsWith(input.command)).toBe(true);
 expect(result.stdout).not.toContain('finite-token');
});

it('a remote scheduling URL denies a heavy native call before any command rewrite', () => {
 const result = spawnSync(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/tool-hook.cjs')], { encoding: 'utf8', input: JSON.stringify({ tool_input: { command: 'make' } }),
   env: { NEXUS_HEAVY_COMMAND_URL: 'https://example.invalid/hook/heavy-command', NEXUS_GATE_TOKEN: 'finite-secret', NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: process.cwd() } });
 expect(result.status).toBe(0); const value = JSON.parse(result.stdout).hookSpecificOutput;
 expect(value.permissionDecision).toBe('deny'); expect(value).not.toHaveProperty('updatedInput'); expect(result.stdout).not.toContain('finite-secret');
});
