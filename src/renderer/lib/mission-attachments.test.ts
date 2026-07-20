import { describe, expect, it } from 'vitest';
import {
  buildMissionAttachmentsContext,
  classifyMissionAttachment,
  filesFromClipboardData,
  namePastedMissionFile,
  validateMissionAttachment,
  type MissionAttachment,
} from './mission-attachments';

function file(name: string, type: string, size = 1000) {
  return { name, type, size };
}

function realFile(name: string, type: string, body = 'png-bytes'): File {
  return new File([body], name, { type });
}

const attachment: MissionAttachment = {
  id: 'one',
  name: 'erro.png',
  kind: 'image',
  mime: 'image/png',
  size: 1000,
  path: '/Users/test/.nexus/dropped/erro.png',
};

describe('mission attachments', () => {
  it('classifies screenshots, audio, and code/text files by mime or extension', () => {
    expect(classifyMissionAttachment(file('erro.png', ''))).toBe('image');
    expect(classifyMissionAttachment(file('falha.m4a', ''))).toBe('audio');
    expect(classifyMissionAttachment(file('notes.txt', 'text/plain'))).toBe('file');
    expect(classifyMissionAttachment(file('app.ts', ''))).toBe('file');
    expect(classifyMissionAttachment(file('binario.exe', 'application/x-msdownload'))).toBeNull();
  });

  it('rejects unsupported, oversized, and empty files', () => {
    expect(validateMissionAttachment(file('binario.exe', 'application/x-msdownload'), [])).toMatch(/imagem/);
    expect(validateMissionAttachment(file('erro.png', 'image/png', 0), [])).toMatch(/vazio/);
    expect(validateMissionAttachment(file('erro.png', 'image/png', 15 * 1024 * 1024), [])).toMatch(/14 MB/);
  });

  it('builds a bounded context block for the mission agents', () => {
    expect(buildMissionAttachmentsContext([attachment])).toContain('erro.png');
    expect(buildMissionAttachmentsContext([])).toBe('');
  });

  it('extracts screenshot pastes and ignores text-only clipboard', () => {
    const shot = realFile('image.png', 'image/png');
    const files = filesFromClipboardData({
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => shot,
        },
        {
          kind: 'string',
          type: 'text/plain',
          getAsFile: () => null,
        },
      ],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/^print-.*\.png$/);
    expect(filesFromClipboardData({ items: [] })).toEqual([]);
    expect(
      filesFromClipboardData({
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      }),
    ).toEqual([]);
  });

  it('renames generic clipboard dumps but keeps real filenames', () => {
    const generic = namePastedMissionFile(realFile('image.png', 'image/png'), 'image');
    expect(generic.name).toMatch(/^print-.*\.png$/);
    const blank = namePastedMissionFile(realFile('', 'image/png'), 'image');
    expect(blank.name).toMatch(/^print-.*\.png$/);
    const kept = namePastedMissionFile(realFile('stack-trace.png', 'image/png'), 'image');
    expect(kept.name).toBe('stack-trace.png');
  });

  it('dedupes the same clipboard file exposed via items and files', () => {
    const shot = realFile('image.png', 'image/png');
    const files = filesFromClipboardData({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => shot }],
      files: [shot],
    });
    expect(files).toHaveLength(1);
  });
});
