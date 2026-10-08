import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { claudeNativeHeavyHookCommand } from './native-heavy-tool-hook';
import { NativeHeavyCommands } from './native-heavy-command';
import { DARWIN_PTY_STAGE_ZERO_SOURCE, nestedHeavyJobBaseCommand, supervisedPtyCommand } from '../pty/darwin-pty-supervisor';
import { watchDarwinHeavyCommand } from '../pty/darwin-heavy-command';
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

for (const { innerSandbox, scheduling, tracedLauncher } of [{ innerSandbox: false, scheduling: true, tracedLauncher: false }, { innerSandbox: true, scheduling: false, tracedLauncher: false }, { innerSandbox: true, scheduling: true, tracedLauncher: false }, { innerSandbox: true, scheduling: true, tracedLauncher: true }]) {
it.runIf(runNative)(`real Claude native Bash receives scoped native admission with its inner sandbox ${innerSandbox ? 'enabled' : 'disabled'} and scheduling ${scheduling}${tracedLauncher ? ' (original traced launcher denied before target)' : ''}`, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-real-claude-'));
 fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\t@printf done > command-ran\n');
 const outside = path.join(os.homedir(), `.nexus-inner-sandbox-fixture-${path.basename(root)}`); fs.writeFileSync(outside, 'protected');
 const helper = path.join(root, 'resources/native/darwin/nexus-pty-supervisor');
 execFileSync(process.execPath, [path.join(process.cwd(), 'scripts/build-darwin-pty-supervisor.mjs'), '--output', helper], { stdio: 'ignore' });
 const runtime = { platform: 'darwin' as const, packaged: false, cwd: root, moduleDir: root };
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'claude-hook', checkoutId: 'finite', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-hook', sessionId: 'finite-hook-session', role: 'user', scope } as AgentGateContext;
 let cliPid = 0, cliAlive = true; const identity = {};
 const proof = new OwnedCommandProcesses((id) => id === ctx.sessionId && cliPid && cliAlive ? { pid: cliPid, identity } : null, undefined, (pid) => watchDarwinHeavyCommand(runtime, pid));
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const transitions: string[] = []; const admissions: unknown[] = [];
 const native = new NativeHeavyCommands({ current: () => cliAlive, claim: (id, pid, proofKind) => proof.claim(id, pid, proofKind), probe: (id, claim) => proof.probe(id, claim), borrow: (id, claim, pid) => proof.borrow(id, claim, pid), stop: (id, claim) => proof.stop(id, claim),
   acquire: async (request) => { const permit = await pool.acquire(request); transitions.push('grant'); return { id: permit.id, release: () => { transitions.push('release'); permit.release(); } }; } });
 let modelCalls = 0; let toolResult: unknown = null;
 const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (part) => { raw += part; if (raw.length > 4 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
   if (req.url === '/hook/heavy-command') {
    if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
    void native.admit(ctx, JSON.parse(raw)).then((result) => { admissions.push(result); res.end(JSON.stringify(result)); }); return;
   }
   if (req.url?.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
   if (req.url?.startsWith('/v1/messages')) {
    const request = JSON.parse(raw); modelCalls++; if (modelCalls > 1) toolResult = request.messages?.filter((message: { role: string }) => message.role === 'user').at(-1)?.content;
    if (modelCalls === 1) streamMessage(res, request.model, { type: 'tool_use', id: 'toolu_finite_make', name: 'Bash', input: { command: `NODE_OPTIONS= /bin/sh -c "/usr/bin/make -f Makefile"; printf outside > ${JSON.stringify(outside)} 2>/dev/null || true`, description: 'finite fixture only' } });
    else streamMessage(res, request.model, { type: 'text', text: 'finite fixture done' }); return;
   }
   res.writeHead(404); res.end('{}');
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address() as { port: number };
 fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), path.join(root, 'heavy-command'), { recursive: true });
 const resources = fs.realpathSync(path.join(root, 'heavy-command'));
 const settings = path.join(root, 'settings.json');
 fs.writeFileSync(settings, JSON.stringify({ ...(innerSandbox ? { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } } : {}), hooks: scheduling ? { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: claudeNativeHeavyHookCommand(), timeout: 5 }] }] } : {} }));
 const base = nestedHeavyJobBaseCommand(runtime);
 // Fixture-only errno observation. Production/general source remains exact.
 if (tracedLauncher) base.args[2] = DARWIN_PTY_STAGE_ZERO_SOURCE.replace('    syscall(26, 0, 0, 0, 0) == 0 or POSIX::_exit(120);', '    if (syscall(26, 0, 0, 0, 0) != 0) { print STDERR "fixture PT_TRACE_ME errno=" . (0 + $!) . "\\n"; POSIX::_exit(120); }');
 const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: root, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(root, 'securestorage'),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'finite-test-credential', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  NEXUS_HEAVY_JOB_BASE: JSON.stringify(base), NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_CURL: '/usr/bin/curl' };
 delete env.ANTHROPIC_API_KEY; delete env.CLAUDECODE; delete env.NODE_OPTIONS; delete env.BASH_ENV; delete env.ZDOTDIR;
 const profile = `(version 1)(allow default)(deny network*)(allow network-outbound (remote tcp "localhost:${port}"))(allow network-bind (local tcp "localhost:*"))(allow network-inbound (local tcp "localhost:*"))(allow network-bind (local unix (subpath ${JSON.stringify(fs.realpathSync(root))})))(allow network-inbound (local unix (subpath ${JSON.stringify(fs.realpathSync(root))})))(allow network-outbound (remote unix (subpath ${JSON.stringify(fs.realpathSync(root))})))`;
 const cliArgs = ['-p', 'finite fixture', '--dangerously-skip-permissions', '--tools', 'Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', settings, '--output-format', 'json'];
 const command = innerSandbox ? supervisedPtyCommand(runtime, claude!, cliArgs) : supervisedPtyCommand(runtime, '/usr/bin/sandbox-exec', ['-p', profile, claude!, ...cliArgs]);
 const child = spawn(command.file, command.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
 cliPid = child.pid!; let stderr = '', stdout = ''; child.stderr.on('data', (part) => stderr += part); child.stdout.on('data', (part) => stdout += part);
 const exit = new Promise<number | null>((resolve) => child.once('close', (code) => { cliAlive = false; resolve(code); }));
 const timer = setTimeout(() => child.kill('SIGTERM'), 25_000);
 try {
  const code = await exit; expect(code, (stderr || stdout).slice(0, 2048)).toBe(0); expect(modelCalls).toBe(2);
  if (tracedLauncher) {
   expect(JSON.stringify(toolResult)).toContain('fixture PT_TRACE_ME errno=1');
   expect(fs.existsSync(path.join(root, 'command-ran'))).toBe(false); expect(admissions).toEqual([]);
  } else expect(fs.readFileSync(path.join(root, 'command-ran'), 'utf8')).toBe('done');
  if (innerSandbox) expect(fs.readFileSync(outside, 'utf8')).toBe('protected');
  await native.drain(); expect(transitions).toEqual(scheduling && !tracedLauncher ? ['grant', 'release'] : []); expect(stdout).toContain('finite fixture done');
 } finally {
  clearTimeout(timer); child.kill('SIGTERM'); await exit; pool.close();
  await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true });
 }
}, 35_000);
}


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

// F-956 review: these ran with exit 0 and no reservation through this hook.
it.each([
 ['nice -n 10 make', 'build'],
 ['find . -name "*.test.ts" | xargs -0 vitest', 'tests'],
 ["sh <<'EOF'\nmake\nEOF", 'build'],
 ['cat <<EOF && make\nbody\nEOF', 'build'],
 ['echo "$(make)"', 'build'],
 ['command -v make', null],
])('the Bash hook admits %j as %s before it runs', (command, kind) => {
 const resources = path.join(process.cwd(), 'resources/heavy-command');
 const result = spawnSync(process.execPath, [path.join(resources, 'tool-hook.cjs')], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
   env: { NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1234/hook/heavy-command', NEXUS_GATE_TOKEN: 'finite-token', NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources } });
 expect(result.status).toBe(0);
 const value = JSON.parse(result.stdout);
 if (kind === null) { expect(value).toEqual({}); return; }
 const rewritten = value.hookSpecificOutput.updatedInput.command as string;
 expect(rewritten).toContain(`"$$" '${kind}'`);
 expect(rewritten.endsWith(command)).toBe(true);
});

it('a remote scheduling URL denies a heavy native call before any command rewrite', () => {
 const result = spawnSync(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/tool-hook.cjs')], { encoding: 'utf8', input: JSON.stringify({ tool_input: { command: 'make' } }),
   env: { NEXUS_HEAVY_COMMAND_URL: 'https://example.invalid/hook/heavy-command', NEXUS_GATE_TOKEN: 'finite-secret', NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: process.cwd() } });
 expect(result.status).toBe(0); const value = JSON.parse(result.stdout).hookSpecificOutput;
 expect(value.permissionDecision).toBe('deny'); expect(value).not.toHaveProperty('updatedInput'); expect(result.stdout).not.toContain('finite-secret');
});
