import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { offloadedSkillManifest } from './offloaded-skill-manifest';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function payloadFile(payload: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-offloaded-skill-'));
  roots.push(dir);
  const file = path.join(dir, 'demo-manifest.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

const bytes = Buffer.from('#!/bin/sh\necho demo\n');
const content = bytes.toString('base64');
const meta = {
  encoding: 'base64' as const,
  executable: true,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
};

describe('offloadedSkillManifest', () => {
  it('does not read the payload until an asset content is needed', () => {
    const file = payloadFile({ 'bin/cli': content });
    const reads = vi.spyOn(fs, 'readFileSync');
    const manifest = offloadedSkillManifest(file, {}, { 'bin/cli': meta });
    expect(manifest['bin/cli']!.encoding).toBe('base64');
    expect(manifest['bin/cli']!.executable).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(manifest['bin/cli']!.content).toBe(content);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('keeps inline assets exactly as generated', () => {
    const manifest = offloadedSkillManifest(
      payloadFile({}),
      { 'SKILL.md': { content: '# Demo\n', encoding: 'utf8', sha256: 'x', size: 7 } },
      {},
    );
    expect(manifest['SKILL.md']).toMatchObject({ content: '# Demo\n', encoding: 'utf8' });
  });

  it('refuses a payload whose bytes do not match the build-time digest', () => {
    const file = payloadFile({ 'bin/cli': Buffer.from('tampered').toString('base64') });
    const manifest = offloadedSkillManifest(file, {}, { 'bin/cli': meta });
    expect(() => manifest['bin/cli']!.content).toThrow(/verification/);
  });

  it('refuses an asset missing from the payload', () => {
    const manifest = offloadedSkillManifest(payloadFile({}), {}, { 'bin/cli': meta });
    expect(() => manifest['bin/cli']!.content).toThrow(/missing/);
  });

  it('releases the payload after the synchronous delivery that needed it', async () => {
    const file = payloadFile({ 'bin/cli': content });
    const reads = vi.spyOn(fs, 'readFileSync');
    const manifest = offloadedSkillManifest(file, {}, { 'bin/cli': meta });
    void manifest['bin/cli']!.content;
    void manifest['bin/cli']!.content;
    expect(reads).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    void manifest['bin/cli']!.content;
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
