import { describe, expect, it } from 'vitest';
import { readableMemoryBody } from './memory-note-readable';

const SYNCED_HANDOFF = [
  '<!-- Edit the body below: the next sync ingests it into the canonical SQLite memory. Frontmatter is identity — changing it only invalidates the file. -->',
  '',
  '# Accepted task handoff',
  '',
  'Accepted handoff:',
  'Mission: mission-7859676b-35a0-4943-991b-42469439faf8',
  'Reference: handoff-7799130a-4a85-402a-a840-dfa474a8bd89',
  'Status: accepted',
  'MCP receipt: abf59500-7dbe-47a2-8e52-bd7f3712d07c',
].join('\n');

describe('readableMemoryBody', () => {
  it('removes the sync editor comment that is not addressed to the operator', () => {
    const { body } = readableMemoryBody(SYNCED_HANDOFF, 'Accepted task handoff');
    expect(body).not.toContain('<!--');
    expect(body).not.toContain('the next sync ingests it');
  });

  it('drops a leading heading that only repeats the card title', () => {
    const { body } = readableMemoryBody(SYNCED_HANDOFF, 'Accepted task handoff');
    expect(body.startsWith('Accepted handoff:')).toBe(true);
    expect(body).not.toContain('# Accepted task handoff');
  });

  it('keeps a heading that carries information the title does not', () => {
    const { body } = readableMemoryBody(
      '# Outra decisão\n\nCorpo real.',
      'Accepted task handoff',
    );
    expect(body).toContain('# Outra decisão');
  });

  it('shortens correlation ids but keeps their label so the line stays legible', () => {
    const { body } = readableMemoryBody(SYNCED_HANDOFF, 'Accepted task handoff');
    expect(body).toContain('Mission: mission-7859676b…');
    expect(body).toContain('Reference: handoff-7799130a…');
    expect(body).not.toContain('42469439faf8');
  });

  it('shortens bare hex receipts that carry no label', () => {
    const { body } = readableMemoryBody('SHA: ' + 'a'.repeat(64));
    expect(body).toBe('SHA: aaaaaaaa…');
  });

  it('strips YAML frontmatter identity that is not human content', () => {
    const { body } = readableMemoryBody(
      '---\nid: note-1\nkind: note\n---\nDecisão registrada.',
    );
    expect(body).toBe('Decisão registrada.');
  });

  it('collapses the blank run a stripped comment leaves behind', () => {
    const { body } = readableMemoryBody(SYNCED_HANDOFF, 'Accepted task handoff');
    expect(body).not.toMatch(/\n{3,}/);
  });

  it('reports plain operator-written notes as untouched', () => {
    const plain = 'Decidimos usar SQLite local.\n\nMotivo: sem servidor.';
    const { body, compacted } = readableMemoryBody(plain, 'Decisão');
    expect(body).toBe(plain);
    expect(compacted).toBe(false);
  });

  it('never throws on an empty body', () => {
    expect(readableMemoryBody('', 'Título')).toEqual({
      body: '',
      compacted: false,
    });
  });
});
