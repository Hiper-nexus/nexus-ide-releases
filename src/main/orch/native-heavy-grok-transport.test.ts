import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

// Opaque wire fixture observed from the installed Grok1.0.50; not a replacement
// shell program. Production accepts only its SHA256f763 and original argv.
const wrapper = "IFS= builtin read -r -d '' __grok_user_cmd <&5; exec 5<&-; builtin set -- \"$__grok_user_cmd\" \"$@\"; builtin unset __grok_user_cmd; snap=$(command cat <&3); builtin shopt -s extglob 2>/dev/null; builtin shopt -s expand_aliases 2>/dev/null; builtin eval -- \"$snap\"; builtin export GROK_AGENT=1; builtin export PWD=\"$(builtin pwd)\"; unalias find 2>/dev/null || true; find() { local __grok_bin=''; [ -x \"$__grok_bin\" ] || __grok_bin=$(command -v bfs 2>/dev/null) || __grok_bin=''; if [ -z \"$__grok_bin\" ]; then command find \"$@\"; return; fi; if [[ -z ${ZSH_VERSION-} ]] && (( BASH_SUBSHELL > 0 )); then exec -a find \"$__grok_bin\" \"$@\"; else (exec -a find \"$__grok_bin\" \"$@\"); fi; }; __grok_shadow_find=1; unalias grep 2>/dev/null || true; grep() { local __grok_bin=''; [ -x \"$__grok_bin\" ] || __grok_bin=$(command -v ugrep 2>/dev/null) || __grok_bin=''; if [ -z \"$__grok_bin\" ]; then command grep \"$@\"; return; fi; if [[ -z ${ZSH_VERSION-} ]] && (( BASH_SUBSHELL > 0 )); then exec -a grep \"$__grok_bin\" -G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl \"$@\"; else (exec -a grep \"$__grok_bin\" -G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl \"$@\"); fi; }; __grok_shadow_grep=1; __grok_user_cmd=\"$1\"; builtin declare +x __grok_user_cmd 2>/dev/null; builtin set --; builtin eval \"$__grok_user_cmd\" 2>&1";
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGTERM'); await closed;
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(options: { missing3?: boolean; missing5?: boolean; writeOnly3?: boolean; writeOnly5?: boolean; wrapper?: string; nodeOptions?: string } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grok-transport-'))); roots.push(root);
  const directory = path.join(root, 'heavy-command');
  fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), directory, { recursive: true });
  const originalEnv = path.join(root, 'original-env.bash');
  fs.writeFileSync(originalEnv, 'printf x >> original-env-count\n');
  const launch = 'template="$FIXTURE_WRAPPER"; unset FIXTURE_WRAPPER; export BASH_ENV="$NEXUS_HEAVY_DIR/shell.bash"; ' +
    (options.writeOnly3 ? 'exec 3>&1; ' : options.writeOnly5 ? 'exec 5>&1; ' : '') +
    'exec 4<&-; exec /bin/bash -O extglob -c "$template" --';
  // The left side's stdout is a real POSIX write-only pipe, not Node's
  // bidirectional socketpair. pipefail preserves the original Bash result.
  const script = options.writeOnly3 || options.writeOnly5 ? `set -o pipefail; { ${launch}; } | /bin/cat` : launch;
  const child = spawn('/bin/bash', ['-c', script], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, FIXTURE_WRAPPER: options.wrapper ?? wrapper,
      NEXUS_HEAVY_DIR: directory, NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_ORIG_BASH_ENV: originalEnv,
      NEXUS_GATE_TOKEN: 'fixture-only', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command',
      NEXUS_HEAVY_JOB_BASE: JSON.stringify({ file: '/usr/bin/perl', args: ['heavy-job'] }),
      ...(options.nodeOptions !== undefined ? { NODE_OPTIONS: options.nodeOptions } : {}) },
    stdio: ['ignore', 'pipe', 'pipe', options.missing3 ? 'ignore' : 'pipe', 'ignore', options.missing5 ? 'ignore' : 'pipe'],
  }); children.push(child);
  let output = '', error = '';
  child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { error += data; });
  for (const index of [3, 5]) child.stdio[index]?.on('error', () => {});
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const writable = (fd: number) => child.stdio[fd] as import('node:stream').Writable | null;
  const sendSnapshot = (body = 'printf x >> snapshot-count; finite_fn() { printf "snapshot-✓"; }; finite_var="quoted value";') => {
    const stream = writable(3); if (!options.missing3) stream!.end(body);
  };
  const send = (bytes: Buffer, close = true) => {
    const stream = writable(5);
    if (options.missing5) return;
    if (close) stream!.end(bytes); else stream!.write(bytes);
  };
  return { root, child, exit, send, sendSnapshot, output: () => output, error: () => error,
    original: () => fs.existsSync(path.join(root, 'original-env-count')),
    snapshot: () => fs.existsSync(path.join(root, 'snapshot-count')) };
}
it.runIf(fs.existsSync('/bin/bash'))('refuses missing inherited FD5 before Node can reuse it or user BASH_ENV runs', async () => {
  const f = fixture({ missing5: true }); f.sendSnapshot();
  expect(await f.exit).toEqual({ code: 78, signal: null });
  expect(f.original()).toBe(false); expect(f.snapshot()).toBe(false);
});
it.runIf(fs.existsSync('/bin/bash'))('refuses missing inherited snapshot FD3 before evaluating any input', async () => {
  const f = fixture({ missing3: true }); f.send(Buffer.from('printf user\0'));
  expect(await f.exit).toEqual({ code: 78, signal: null });
  expect(f.original()).toBe(false); expect(f.snapshot()).toBe(false);
});
it.runIf(fs.existsSync('/bin/bash'))('delayed trivial input restores original environment/functions once without admission or suppression leak', async () => {
  const f = fixture({ nodeOptions: '--max-old-space-size=111' }); f.sendSnapshot();
  expect(f.original()).toBe(false);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  f.send(Buffer.from('finite_fn; printf "|%s|%s|%s" "$finite_var" "$NODE_OPTIONS" "${NEXUS_HEAVY_GROK_REPLAY-unset}"\0'));
  expect(await f.exit).toEqual({ code: 0, signal: null });
  expect(f.output()).toBe('snapshot-✓|quoted value|--max-old-space-size=111|unset');
  expect(fs.readFileSync(path.join(f.root, 'snapshot-count'), 'utf8')).toBe('x');
  expect(fs.readFileSync(path.join(f.root, 'original-env-count'), 'utf8')).toBe('x');
});
it.runIf(fs.existsSync('/bin/bash')).each(['missing-nul', 'bad-utf8', 'trailing', 'second-frame', 'oversize'])('refuses %s without snapshot/user execution', async kind => {
  const f = fixture(); f.sendSnapshot();
  const bytes = kind === 'missing-nul' ? Buffer.from('printf user') : kind === 'bad-utf8' ? Buffer.from([0xff, 0]) :
    kind === 'trailing' ? Buffer.from('printf user\0x') : kind === 'second-frame' ? Buffer.from('printf user\0printf twice\0') : Buffer.alloc(131074, 97);
  f.send(bytes); expect(await f.exit).toEqual({ code: 78, signal: null });
  expect(f.original()).toBe(false); expect(f.snapshot()).toBe(false); expect(f.output()).toBe('');
});
it.runIf(fs.existsSync('/bin/bash'))('bounds producer EOF wait without executing a complete prefix', async () => {
  const f = fixture(); f.sendSnapshot(); f.send(Buffer.from('printf user\0'), false);
  expect(await f.exit).toEqual({ code: 78, signal: null });
  expect(f.original()).toBe(false); expect(f.snapshot()).toBe(false);
}, 8000);
it.runIf(fs.existsSync('/bin/bash'))('cancellation while input is incomplete closes the reader before any code executes', async () => {
  const f = fixture(); f.sendSnapshot(); f.send(Buffer.from('printf'), false);
  await new Promise<void>(resolve => setTimeout(resolve, 100)); f.child.kill('SIGTERM');
  expect((await f.exit).signal).toBe('SIGTERM');
  expect(f.original()).toBe(false); expect(f.snapshot()).toBe(false);
});
it.runIf(fs.existsSync('/bin/bash'))('an unknown Grok wrapper fails closed but unrelated FD5 Bash is unchanged', async () => {
  const bad = fixture({ wrapper: wrapper + ' ' }); bad.sendSnapshot(); bad.send(Buffer.from('printf user\0'));
  expect(await bad.exit).toEqual({ code: 78, signal: null }); expect(bad.original()).toBe(false);
  const ordinary = fixture({ wrapper: 'printf ordinary' }); ordinary.sendSnapshot(); ordinary.send(Buffer.from('unrelated\0'));
  expect(await ordinary.exit).toEqual({ code: 0, signal: null }); expect(ordinary.output()).toBe('ordinary');
});

it.runIf(fs.existsSync('/bin/bash')).each(['3', '5'])('refuses a real write-only PIPE%s without consuming snapshot/user startup', async fd => {
  const f = fixture(fd === '3' ? { writeOnly3: true } : { writeOnly5: true });
  f.sendSnapshot(); f.send(Buffer.from('printf user\0'));
  expect(await f.exit).toEqual({ code: 78, signal: null });
  expect(f.original()).toBe(false); expect(f.snapshot()).toBe(false); expect(f.output()).toBe('');
});

it('cancel during a held inherited-lease validation never launches the target and closes its validator', async () => {
  let validatorSocketClosed = false;
  let release!: () => void;
  let observed!: () => void;
  const requestSeen = new Promise<void>(resolve => { observed = resolve; });
  const server = http.createServer((request, response) => {
    request.resume(); request.on('end', () => {
      response.on('close', () => { validatorSocketClosed = true; });
      release = () => response.end(JSON.stringify({ allow: true, leaseId: 'owned-existing-lease' }));
      observed();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/job-launch.cjs'), 'build', '/bin/sh', '-c', 'printf forbidden-target'], {
    env: { PATH: '/usr/bin:/bin', NEXUS_HEAVY_JOB_BASE: JSON.stringify({ file: '/usr/bin/perl', args: ['heavy-job'] }),
      NEXUS_HEAVY_LEASE: 'owned-existing-lease', NEXUS_GATE_TOKEN: 'fixture-only',
      NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook/heavy-command` },
    stdio: ['ignore', 'pipe', 'pipe'],
  }); children.push(child);
  let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.resume();
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await requestSeen; child.kill('SIGTERM');
    let settled = false; void exit.then(() => { settled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    const stoppedBeforeAllow = settled;
    const validatorClosedBeforeAllow = validatorSocketClosed;
    release();
    expect(await exit).toEqual({ code: null, signal: 'SIGTERM' });
    expect(stoppedBeforeAllow).toBe(true);
    expect(validatorClosedBeforeAllow).toBe(true);
    expect(output).toBe('');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 8000);
