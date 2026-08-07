import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_MEMORY_PROJECTION,
  projectionCounts,
  resolveMemoryRoot,
  writeCanonicalMemoryProjection,
  type CanonicalMemoryProjectionInput,
} from './nexus-memory';
import { collectProjectionEdits } from './nexus-memory-ingest';

/**
 * H4 inverts the premise of the projection: the file is no longer only a view.
 * What it may *say* is still bounded — identity, provenance and freshness are
 * decided by the same rules that hardened the projection against planted files.
 * These tests pin the boundary between "the operator edited the body" and every
 * other reason a file can differ from the row it projects.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mem-ingest-'));
  dirs.push(root);
  return root;
}

const ID = 'mem-22222222-2222-4222-8222-222222222222';
const OTHER_ID = 'mem-33333333-3333-4333-8333-333333333333';

function record(
  overrides: Partial<CanonicalMemoryProjectionInput> = {},
): CanonicalMemoryProjectionInput {
  return {
    id: ID,
    content: '# Regra\n\nnão duplicar serviço de domínio',
    kind: 'decision',
    scope: 'workspace',
    importance: 4,
    source: 'operator:decision',
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function projectionPath(root: string, id = ID): string {
  return path.join(resolveMemoryRoot(root), `${id}.md`);
}

describe('collectProjectionEdits', () => {
  it('reads back the operator edit as the new content', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, record());
    const file = projectionPath(root);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace(
        'não duplicar serviço de domínio',
        'não duplicar serviço de domínio — vale para o gateway também',
      ),
    );

    const edits = collectProjectionEdits(root, [record()]);

    expect(edits).toHaveLength(1);
    expect(edits[0].id).toBe(ID);
    expect(edits[0].baseUpdatedAt).toBe(20);
    expect(edits[0].content).toContain('vale para o gateway também');
    expect(edits[0].content).toContain('# Regra');
  });

  it('does not report an untouched projection as an edit', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, record());

    expect(collectProjectionEdits(root, [record()])).toEqual([]);
  });

  /**
   * The renderer re-emits the first heading as the title, so a memory stored
   * without one round-trips to a *different* body. Diffing rendered bodies (not
   * raw bytes against stored content) is what keeps that from looking like an
   * operator edit on every single pass.
   */
  it('does not invent an edit for content stored without a heading', () => {
    const root = project();
    const headless = record({ content: 'anotação solta sem título' });
    writeCanonicalMemoryProjection(root, headless);

    expect(collectProjectionEdits(root, [headless])).toEqual([]);
  });

  it('ignores an edit made against a version SQLite has already moved past', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, record({ updatedAt: 20 }));
    const file = projectionPath(root);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('não duplicar', 'EDITADO'),
    );

    // The row advanced after that file was written: the file is stale, and a
    // stale file never wins — it is repaired from SQLite instead.
    expect(collectProjectionEdits(root, [record({ updatedAt: 31 })])).toEqual(
      [],
    );
  });

  it('ignores a file whose declared id disagrees with its filename', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, record());
    const file = projectionPath(root);
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(`id: ${ID}`, `id: ${OTHER_ID}`)
        .replace('não duplicar', 'EDITADO'),
    );

    expect(collectProjectionEdits(root, [record()])).toEqual([]);
  });

  it('ignores a file that lost the canonical marker', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, record());
    fs.writeFileSync(projectionPath(root), '# conteúdo adulterado\n');

    expect(collectProjectionEdits(root, [record()])).toEqual([]);
  });

  it('never lets a planted file speak for a memory that has no row', () => {
    const root = project();
    fs.mkdirSync(resolveMemoryRoot(root), { recursive: true });
    fs.writeFileSync(
      projectionPath(root, OTHER_ID),
      `---\nid: ${OTHER_ID}\ncanonical: ${CANONICAL_MEMORY_PROJECTION}\nkind: note\nupdatedAt: 20\n---\n\n# Plantada\n\ncorpo plantado\n`,
    );

    expect(collectProjectionEdits(root, [record()])).toEqual([]);
  });

  it('survives a missing projection file without proposing anything', () => {
    const root = project();
    fs.mkdirSync(resolveMemoryRoot(root), { recursive: true });

    expect(collectProjectionEdits(root, [record()])).toEqual([]);
  });
});

describe('projectionCounts', () => {
  it('counts notes per kind and serves repeat calls from the stat cache', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, record());
    writeCanonicalMemoryProjection(
      root,
      record({
        id: OTHER_ID,
        kind: 'note',
        source: 'operator:note',
        content: '# Nota\n\ncorpo',
      }),
    );

    const first = projectionCounts(root);
    expect(first.notes).toBe(2);
    expect(first.byKind.decision).toBe(1);
    expect(first.byKind.note).toBe(1);

    // "Cheap" is the whole point: a status call must not re-read the directory
    // contents that listMemoryNotes already walked.
    expect(projectionCounts(root).cached).toBe(true);
  });

  it('invalidates the cache when a projection changes on disk', () => {
    const root = project();
    writeCanonicalMemoryProjection(root, record());
    expect(projectionCounts(root).notes).toBe(1);
    expect(projectionCounts(root).cached).toBe(true);

    writeCanonicalMemoryProjection(
      root,
      record({ id: OTHER_ID, content: '# Outra\n\ncorpo' }),
    );

    const after = projectionCounts(root);
    expect(after.cached).toBe(false);
    expect(after.notes).toBe(2);
  });
});
