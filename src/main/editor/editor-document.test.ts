import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  assertExpectedContentHash,
  assertEditorPathInWorkspace,
  hashContent,
  markSaved,
  openEditorDocument,
  setMarkdownMode,
} from './editor-document';

describe('editor document', () => {
  it('opens text, tracks dirty, hashes saves', () => {
    const doc = openEditorDocument({
      path: 'src/a.ts',
      bytes: Buffer.from('const x = 1\n'),
    });
    expect(doc.dirty).toBe(false);
    expect(doc.binary).toBe(false);
    const edited = applyEdit(doc, 'const x = 2\n');
    expect(edited.dirty).toBe(true);
    const saved = markSaved(edited);
    expect(saved.dirty).toBe(false);
    expect(saved.contentHash).toBe(hashContent('const x = 2\n'));
  });

  it('rejects a save based on stale editor content', () => {
    const current = openEditorDocument({
      path: 'src/a.ts',
      bytes: Buffer.from('externally changed\n'),
    });

    expect(() =>
      assertExpectedContentHash(current, hashContent('original\n')),
    ).toThrow(/changed on disk/i);
    expect(() =>
      assertExpectedContentHash(current, current.contentHash),
    ).not.toThrow();
  });

  it('flags binary and oversized files', () => {
    const bin = openEditorDocument({
      path: 'a.bin',
      bytes: Buffer.from([0, 1, 2, 3, 0, 0, 0]),
    });
    expect(bin.binary).toBe(true);

    const big = openEditorDocument({
      path: 'big.txt',
      bytes: Buffer.alloc(100),
      maxBytes: 10,
    });
    expect(big.tooLarge).toBe(true);
  });

  it('refuses path escape and supports markdown read mode', () => {
    expect(() =>
      assertEditorPathInWorkspace('/ws', '../etc/passwd'),
    ).toThrow(/outside/);
    // Sibling-prefix trap: /workspace-evil must not pass for root /workspace
    expect(() =>
      assertEditorPathInWorkspace('/workspace', '../workspace-evil/x'),
    ).toThrow(/outside/);
    expect(assertEditorPathInWorkspace('/workspace', 'src/a.ts')).toBe(
      '/workspace/src/a.ts',
    );
    const md = openEditorDocument({
      path: 'README.md',
      bytes: Buffer.from('# Hi\n'),
    });
    expect(md.mode).toBe('markdown-read');
    expect(setMarkdownMode(md, 'edit').mode).toBe('edit');
  });

  it('opens ~1MB text within test budget', () => {
    const content = 'a'.repeat(1_000_000);
    const started = Date.now();
    const doc = openEditorDocument({
      path: 'large.txt',
      bytes: Buffer.from(content),
    });
    expect(doc.content.length).toBe(1_000_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
