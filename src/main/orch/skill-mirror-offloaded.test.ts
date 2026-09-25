import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Main bundle ships impeccable as an offloaded manifest (index + payload
 * on disk, see skill-manifest-offload). A fresh process must verify an intact
 * delivery from the build-time digests alone, without reading the payload.
 */
const offload = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nexus-offload-payload-'));
  return { dir, payloadFile: nodePath.join(dir, 'impeccable-manifest.json') };
});

const binary = Buffer.alloc(64 * 1024, 5);

vi.mock('./impeccable-manifest', async () => {
  const { offloadedSkillManifest } = await import('./offloaded-skill-manifest');
  const content = binary.toString('base64');
  fs.writeFileSync(offload.payloadFile, JSON.stringify({ 'scripts/bin/cli': content }));
  const skill = '---\nname: impeccable\ndescription: demo\n---\n';
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return {
    IMPECCABLE_MANIFEST: offloadedSkillManifest(
      offload.payloadFile,
      {
        'SKILL.md': {
          content: skill,
          encoding: 'utf8',
          sha256: digest(Buffer.from(skill)),
          size: Buffer.byteLength(skill),
        },
      },
      {
        'scripts/bin/cli': {
          encoding: 'base64',
          executable: true,
          sha256: digest(binary),
          size: binary.length,
        },
      },
    ),
  };
});

vi.mock('../jev/jev-secrets', () => ({ hasJevCredential: () => true }));

const { __resetSkillMirrorCachesForTests, ensureSkillsForCli } = await import('./skill-mirror');

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skill-offload-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('offloaded bundled skill', () => {
  it('materializes the offloaded asset byte for byte and runnable', () => {
    const home = tmpRoot();
    ensureSkillsForCli('codex', { home, sourceDirs: [], allowedSkills: ['impeccable'] });
    const generated = path.join(
      home, '.nexus', 'generated-skills', 'impeccable', 'scripts', 'bin', 'cli',
    );
    expect(fs.readFileSync(generated).equals(binary)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(generated).mode & 0o111).not.toBe(0);
    }
  });

  it('verifies an intact delivery in a fresh process without reading the payload', async () => {
    const home = tmpRoot();
    const options = { home, sourceDirs: [], allowedSkills: ['impeccable'] };
    ensureSkillsForCli('codex', options);
    // Let the payload held by the first delivery go, as between two spawns.
    await new Promise((resolve) => setImmediate(resolve));
    __resetSkillMirrorCachesForTests();
    const reads = vi.spyOn(fs, 'readFileSync');

    ensureSkillsForCli('codex', options);

    expect(reads.mock.calls.filter(([file]) => String(file) === offload.payloadFile))
      .toEqual([]);
  });

  it('reads the payload again to repair a damaged copy', async () => {
    const home = tmpRoot();
    const options = { home, sourceDirs: [], allowedSkills: ['impeccable'] };
    ensureSkillsForCli('codex', options);
    await new Promise((resolve) => setImmediate(resolve));
    const generated = path.join(
      home, '.nexus', 'generated-skills', 'impeccable', 'scripts', 'bin', 'cli',
    );
    fs.writeFileSync(generated, Buffer.alloc(binary.length, 9));
    __resetSkillMirrorCachesForTests();

    ensureSkillsForCli('codex', options);

    expect(fs.readFileSync(generated).equals(binary)).toBe(true);
  });
});
