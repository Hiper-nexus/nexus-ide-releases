import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { prepareHeavyZshProfile, cleanupHeavyZshProfile } from './native-heavy-zdotdir';
import { buildScopedExecPlan } from '../runtime/process-sandbox';
import { createPtyHostBridge, type HostControlMsg } from '../pty/pty-host-core';

const roots: string[] = [];
const tokens: string[] = [];
afterEach(() => { for (const token of tokens.splice(0)) cleanupHeavyZshProfile(token); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-zdot-')));
  roots.push(root);
  const resources = path.join(root, 'App.app', 'Contents', 'Resources', 'heavy-command');
  const home = path.join(root, 'user profile');
  fs.mkdirSync(path.dirname(resources), { recursive: true });
  fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), resources, { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.zshrc'), 'autoload -Uz compinit; compinit -u\n' +
    'HISTFILE="$ZDOTDIR/.zsh_history"; print -r -- history >> "$HISTFILE"\n' +
    'zcompile "$ZDOTDIR/.zshrc"\nmkdir -p "$ZDOTDIR/.zcompcache"\n');
  const token = 'fixture-' + roots.length + '-' + Math.random().toString(36).slice(2); tokens.push(token);
  const profile = prepareHeavyZshProfile(token, resources, home);
  const env = { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: profile.directory, NEXUS_HEAVY_ZDOTDIR: profile.directory, NEXUS_HEAVY_DIR: resources,
    NEXUS_HEAVY_ORIG_ZDOTDIR: home, BASH_ENV: path.join(resources, 'shell.bash'),
    NEXUS_HEAVY_BASH_ENV: path.join(resources, 'shell.bash') };
  return { root, resources, home, env, profile, token };
}
function inventory(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? [`${entry.name}/`, ...inventory(file).map(item => `${entry.name}/${item}`)]
      : [`${entry.name}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`];
  }).sort();
}

it.runIf(process.platform === 'darwin').each(['shell', 'cli-agent', 'command', 'watcher'])(
  'shared PTY bridge %s startup and snapshot writes caches outside signed resources', (kind) => {
    const { root, resources, home, env, profile } = fixture();
    const before = inventory(resources);
    let launched = false;
    const bridge = createPtyHostBridge({ ensure: () => {}, post: (message: HostControlMsg) => {
      if (message.type !== 'spawn') return;
      launched = true;
      expect(message.env.BASH_ENV).toBe(path.join(resources, 'shell.bash'));
      const run = spawnSync(message.file, message.args, { cwd: message.cwd, env: message.env, encoding: 'utf8', timeout: 15_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('writable-profile');
    } });
    bridge.host.spawn({ sessionId: kind, file: '/bin/zsh', args: ['-lic',
      'source "$HOME/.zshrc"; /bin/zsh -lc \'source "$HOME/.zshrc"\'; [[ "$ZDOTDIR" == "$NEXUS_HEAVY_ZDOTDIR" ]] && print writable-profile'],
      cwd: root, env, cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    expect(launched).toBe(true);
    expect(inventory(resources)).toEqual(before);
    for (const cache of ['.zcompdump', '.zsh_history', '.zshrc.zwc', '.zcompcache']) expect(fs.existsSync(path.join(profile.directory, cache)) || fs.existsSync(path.join(home, cache))).toBe(true);
  },
);

it.runIf(process.platform === 'darwin')('late readiness still leaves bootstrap and snapshot caches outside the bundle', async () => {
  const { root, resources, home, env } = fixture();
  const before = inventory(resources);
  let resolve!: (value: { args?: string[] }) => void;
  let launched = false;
  const bridge = createPtyHostBridge({ ensure: () => {}, post: (message) => {
    if (message.type !== 'spawn') return;
    launched = true;
    const run = spawnSync(message.file, message.args, { cwd: message.cwd, env: message.env, encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr).toBe(0);
  } });
  bridge.host.spawn({ sessionId: 'late', file: '/bin/zsh', args: ['-lc', 'source "$HOME/.zshrc"'], cwd: root, env, cols: 80, rows: 24 },
    { onData: () => {}, onExit: () => {} }, { wait: new Promise(res => { resolve = res; }), assertCurrent: () => {}, cleanup: async () => {} });
  expect(launched).toBe(false);
  fs.appendFileSync(path.join(home, '.zshrc'), 'print late >> "$ZDOTDIR/.zsh_history"\n');
  resolve({});
  await Promise.resolve();
  expect(launched).toBe(true);
  expect(inventory(resources)).toEqual(before);
});

it.runIf(process.platform === 'darwin')('refuses a user zshenv redirect into signed Resources before later startup can write caches', () => {
  const { root, resources, home, env } = fixture();
  const before = inventory(resources);
  fs.writeFileSync(path.join(home, '.zshenv'), 'export ZDOTDIR="$NEXUS_HEAVY_DIR"\n');
  const run = spawnSync('/bin/zsh', ['-lic', 'true'], { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
  expect(run.status).toBe(78);
  expect(inventory(resources)).toEqual(before);
});

it.runIf(process.platform === 'darwin')('direct nested zsh still cannot start a heavy native command without admission', () => {
  const { root, resources, home, env } = fixture();
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const marker = path.join(root, 'started');
  fs.writeFileSync(path.join(bin, 'cargo'), '#!/bin/sh\nprintf started > "$NEXUS_TEST_STARTED"\n', { mode: 0o755 });
  const run = spawnSync('/bin/zsh', ['-lc', '/bin/zsh -c "$NEXUS_TEST_INNER_COMMAND"'], {
    cwd: root, env: { ...env, PATH: `${bin}:/usr/bin:/bin`, NEXUS_HEAVY_NODE: process.execPath,
      NEXUS_GATE_TOKEN: 'bounded-test', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command',
      NEXUS_TEST_STARTED: marker, NEXUS_TEST_INNER_COMMAND: 'cargo test' }, encoding: 'utf8', timeout: 15_000,
  });
  expect(fs.existsSync(marker)).toBe(false);
  expect(run.status, run.stderr).toBe(78);
  expect(fs.existsSync(path.join(resources, '.zcompdump'))).toBe(false);
});

it.runIf(process.platform === 'darwin').each(['stdin', 'script', 'variable'])(
  'nested zsh %s retains admission before native execution', (mode) => {
    const { root, home, env } = fixture();
    fs.writeFileSync(path.join(home, '.zshrc'), '');
    // `make --version` sozinho é pedido trivial e não é medido (F-982, segunda
    // revisão); `-s` mantém uma invocação real do make, que sai 0 e imprime a versão.
    const program = '/usr/bin/make -s --version';
    const script = path.join(root, 'child.zsh'); fs.writeFileSync(script, program);
    const command = mode === 'stdin' ? '/bin/zsh -s' : mode === 'script' ? '/bin/zsh "$NEXUS_TEST_SCRIPT"' : '$SHELL -c "$NEXUS_TEST_PROGRAM"';
    const run = spawnSync('/bin/zsh', ['-c', command], { cwd: root,
      env: { ...env, SHELL: '/bin/zsh', NEXUS_TEST_SCRIPT: script, NEXUS_TEST_PROGRAM: program,
        NEXUS_HEAVY_NODE: process.execPath, NEXUS_GATE_TOKEN: 'bounded-test',
        NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' },
      input: program, encoding: 'utf8', timeout: 10_000 });
    expect(run.status, run.stdout + run.stderr).toBe(78);
  },
);

it.runIf(process.platform === 'darwin')('Seatbelt permits caches and user rc compilation but protects startup code, bytecode and ancestors', () => {
  const { root, resources, home, env, profile } = fixture();
  const before = inventory(resources);
  fs.writeFileSync(path.join(home, '.zshrc'), 'autoload -Uz compinit; compinit -u\n' +
    'print history >> "$ZDOTDIR/.zsh_history"\nzcompile "$HOME/.zshrc"\n');
  const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const run = (command: string) => {
    const plan = buildScopedExecPlan({ platform: 'darwin', executable: '/bin/zsh', args: ['-lic', command],
      cwd: workspace, rootRealPath: workspace, sandboxDir: runtime, processHome: home, env,
      sandboxProfile: 'workspace-net', extraReadPaths: [resources, home], extraWritePaths: [home],
      protectedWritePaths: profile.protectedWritePaths, protectedDirectoryPaths: profile.protectedDirectoryPaths });
    return spawnSync(plan.file, plan.args, { cwd: plan.cwd, env: plan.env, encoding: 'utf8', timeout: 10_000 });
  };
  const started = run('source "$HOME/.zshrc"; print ready');
  expect(started.status, started.stderr).toBe(0); expect(started.stdout).toContain('ready');
  expect(fs.existsSync(path.join(profile.directory, '.zcompdump'))).toBe(true);
  expect(fs.existsSync(path.join(profile.directory, '.zsh_history'))).toBe(true);
  expect(fs.existsSync(path.join(home, '.zshrc.zwc'))).toBe(true);
  for (const command of [
    'print unsafe > "$ZDOTDIR/.zshenv"', 'print unsafe > "$ZDOTDIR/.zshenv.zwc"',
    'rm "$ZDOTDIR/.zshenv"', 'mv "$ZDOTDIR" "$ZDOTDIR-moved"',
    'mv "${ZDOTDIR:h}" "${ZDOTDIR:h}-moved"', 'set -e; zcompile "$ZDOTDIR/.zshrc"; print unsafe',
  ]) {
    const denied = run(command); expect(denied.status, command + denied.stderr).not.toBe(0);
    expect(denied.stdout).not.toContain('unsafe');
  }
  expect(inventory(resources)).toEqual(before);
  expect(fs.readFileSync(path.join(profile.directory, '.zshenv'))).toEqual(fs.readFileSync(path.join(resources, '.zshenv')));
});

it('reuses only the live Main-owned profile and removes it during session teardown', () => {
  const { resources, home, profile, token } = fixture();
  expect(prepareHeavyZshProfile(token, resources, home)).toBe(profile);
  cleanupHeavyZshProfile(token);
  expect(fs.existsSync(profile.directory)).toBe(false);
});


it.runIf(process.platform === 'darwin').each(['stdin', 'script', 'variable', 'bash'])(
  'nested %s executes with an admitted lease', async (mode) => {
    const { root, home, env } = fixture();
    fs.writeFileSync(path.join(home, '.zshrc'), '');
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++; request.resume(); response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ allow: true, leaseId: 'finite-native-zsh-lease' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    // `make --version` sozinho é pedido trivial e não é medido (F-982, segunda
    // revisão); `-s` mantém uma invocação real do make, que sai 0 e imprime a versão.
    const program = '/usr/bin/make -s --version';
    const script = path.join(root, 'child.zsh'); fs.writeFileSync(script, program);
    const command = mode === 'stdin' ? '/bin/zsh -s' : mode === 'script' ? '/bin/zsh "$NEXUS_TEST_SCRIPT"' :
      mode === 'bash' ? '/bin/bash -c "$NEXUS_TEST_PROGRAM"' : '$SHELL -c "$NEXUS_TEST_PROGRAM"';
    try {
      const child = spawn('/bin/zsh', ['-c', command], { cwd: root,
        env: { ...env, SHELL: '/bin/zsh', NEXUS_TEST_SCRIPT: script, NEXUS_TEST_PROGRAM: program,
          NEXUS_HEAVY_NODE: process.execPath, NEXUS_GATE_TOKEN: 'bounded-test',
          NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command` }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.end(program);
      let output = ''; let errors = '';
      child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { errors += part; });
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(code, errors).toBe(0); expect(output).toContain('GNU Make'); expect(requests).toBe(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  },
);
