import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const script = fs.readFileSync(new URL('./smoke-debian-package.sh', import.meta.url), 'utf8');
const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture({ version = '1.2.3', withZip = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus Debian smoke '));
  fixtures.push(root);
  const bin = path.join(root, 'bin');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(bin);
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'smoke-debian-package.sh'), script);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version, nexusRelease: { node: process.versions.node } }));
  for (const relative of [
    `out/make/deb/x64/nexus-ide_${version}_amd64.deb`,
    ...(withZip ? [`out/make/zip/linux/x64/NexusIDE-linux-x64-${version}.zip`] : []),
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'test artifact');
  }
  const recorded = path.join(root, 'docker-arguments.jsonl');
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}\n` +
    "const fs=require('node:fs'); const args=process.argv.slice(2); " +
    "fs.appendFileSync(process.env.NEXUS_TEST_DOCKER_CALLS, JSON.stringify(args)+'\\n'); " +
    "if(args[0]==='image') process.stdout.write('linux/amd64\\n');\n", { mode: 0o755 });
  return { root, recorded, env: {
    ...process.env,
    PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    NEXUS_TEST_DOCKER_CALLS: recorded,
  } };
}

describe('Debian package smoke host boundary', () => {
  it('uses immutable amd64 image and read-only input mounts without forwarding credentials', () => {
    const f = fixture();
    const result = spawnSync('bash', ['scripts/smoke-debian-package.sh'], { cwd: f.root, env: f.env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const calls = fs.readFileSync(f.recorded, 'utf8').trim().split('\n').map(JSON.parse);
    const image = 'debian@sha256:f3034a6ec3c1205360777c4aae76234998866ad18806ae62b63a3f84ccad782b';
    expect(calls.find((args) => args[0] === 'pull')).toEqual(['pull', '--platform', 'linux/amd64', image]);
    const run = calls.find((args) => args[0] === 'run');
    expect(run).toEqual([
      'run', '--rm', '--init', '--platform', 'linux/amd64', '--shm-size=1g',
      '--mount', `type=bind,src=${f.root},dst=/workspace,readonly`,
      '--mount', `type=bind,src=${path.dirname(path.dirname(process.execPath))},dst=/opt/nexus-node,readonly`,
      '--workdir', '/workspace', '--env', 'PATH=/opt/nexus-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '--env', 'NEXUS_DEBIAN_CONTAINER=1',
      '--env', 'NEXUS_DEBIAN_VERSION=1.2.3', '--env', `NEXUS_DEBIAN_NODE_VERSION=${process.versions.node}`,
      '--entrypoint', '/bin/bash', image, '/workspace/scripts/smoke-debian-package.sh', '--inside-container',
    ]);
  });

  it('does not start Docker when the built ZIP is missing', () => {
    const f = fixture({ withZip: false });
    const result = spawnSync('bash', ['scripts/smoke-debian-package.sh'], { cwd: f.root, env: f.env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(f.recorded)).toBe(false);
  });

  it('does not start Docker for an unsafe package version', () => {
    const f = fixture({ version: '1.2.3;unexpected' });
    const result = spawnSync('bash', ['scripts/smoke-debian-package.sh'], { cwd: f.root, env: f.env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(f.recorded)).toBe(false);
  });
});
