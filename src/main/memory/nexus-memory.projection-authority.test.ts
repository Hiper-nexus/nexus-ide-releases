import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_MEMORY_PROJECTION,
  listMemoryNotes,
  resolveMemoryRoot,
  syncCanonicalMemoryProjections,
  writeCanonicalMemoryProjection,
  type CanonicalMemoryProjectionInput,
} from './nexus-memory';

/**
 * The readable projection is served to mission search and the product-wave IPC,
 * so a file that merely *carries* the canonical marker must not be able to
 * speak for a memory. Identity is only real when the declared id agrees with
 * the filename the writer derives from that same id.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-authority-'));
  dirs.push(root);
  return root;
}

const ACTIVE_ID = 'mem-11111111-1111-4111-8111-111111111111';

function input(
  overrides: Partial<CanonicalMemoryProjectionInput> = {},
): CanonicalMemoryProjectionInput {
  return {
    id: ACTIVE_ID,
    content: '# Real\n\nauthoritative body',
    kind: 'note',
    scope: 'workspace',
    importance: 3,
    source: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function plant(root: string, name: string, id: string, body = 'planted'): string {
  const file = path.join(resolveMemoryRoot(root), name);
  fs.writeFileSync(
    file,
    `---\nid: ${id}\ncanonical: ${CANONICAL_MEMORY_PROJECTION}\nkind: mission\n---\n\n# Planted\n\n${body}\n`,
  );
  return file;
}

describe('projection identity', () => {
  it('does not serve a planted note whose id disagrees with its filename', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, input());
    plant(root, 'forjada.md', 'mem-forjada');

    expect(listMemoryNotes(root).map((n) => n.id)).toEqual([ACTIVE_ID]);
  });

  it('does not let an impostor impersonate a live memory id', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, input());
    plant(root, 'outro-nome.md', ACTIVE_ID, 'attacker controlled');

    const notes = listMemoryNotes(root);
    expect(notes.filter((n) => n.id === ACTIVE_ID)).toHaveLength(1);
    expect(notes[0].body).not.toContain('attacker controlled');
  });

  it('reaps an impostor even when it declares an active id', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, input());
    const impostor = plant(root, 'impostor.md', ACTIVE_ID);

    syncCanonicalMemoryProjections(root, [input()]);

    expect(fs.existsSync(impostor)).toBe(false);
    expect(listMemoryNotes(root).map((n) => n.id)).toEqual([ACTIVE_ID]);
  });

  it('still reaps a genuine projection once its id goes inactive', () => {
    const root = project();
    const stale = writeCanonicalMemoryProjection(root, input());

    syncCanonicalMemoryProjections(root, []);

    expect(fs.existsSync(stale.path)).toBe(false);
  });

  it('preserves unrelated human Markdown without the canonical marker', () => {
    const root = project();
    const human = path.join(resolveMemoryRoot(root), 'notas-do-time.md');
    fs.mkdirSync(path.dirname(human), { recursive: true });
    fs.writeFileSync(human, '# Minhas notas\n\nescrito por humano\n');

    syncCanonicalMemoryProjections(root, [input()]);

    expect(fs.readFileSync(human, 'utf8')).toContain('escrito por humano');
  });
});

describe('projection crash safety', () => {
  it('sweeps a temp file orphaned by a crash between open and rename', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, input());
    const orphan = path.join(
      resolveMemoryRoot(root),
      `${ACTIVE_ID}.md.0123456789abcdef.tmp`,
    );
    fs.writeFileSync(orphan, 'partial write');

    syncCanonicalMemoryProjections(root, [input()]);

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('does not rewrite an unchanged projection (anti onChange loop)', () => {
    const root = project();
    const first = writeCanonicalMemoryProjection(root, input());
    const mtime = fs.statSync(first.path).mtimeMs;

    writeCanonicalMemoryProjection(root, input());
    syncCanonicalMemoryProjections(root, [input()]);

    expect(fs.statSync(first.path).mtimeMs).toBe(mtime);
  });
});

describe('projection root containment', () => {
  it('refuses to write through a symlinked root swapped in after resolution', () => {
    const root = project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-outside-'));
    dirs.push(outside);
    fs.symlinkSync(outside, path.join(root, '.nexus-memory'));

    expect(() => writeCanonicalMemoryProjection(root, input())).toThrow(
      /escap/i,
    );
    expect(fs.readdirSync(outside)).toHaveLength(0);
  });
});
