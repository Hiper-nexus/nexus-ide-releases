import { describe, expect, it } from 'vitest';
import {
  buildMissionAttachmentsContext,
  classifyMissionAttachment,
  validateMissionAttachment,
  type MissionAttachment,
} from './mission-attachments';

function file(name: string, type: string, size = 1000) {
  return { name, type, size };
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
  it('classifies screenshots and audio by mime or extension', () => {
    expect(classifyMissionAttachment(file('erro.png', ''))).toBe('image');
    expect(classifyMissionAttachment(file('falha.m4a', ''))).toBe('audio');
    expect(classifyMissionAttachment(file('notes.txt', 'text/plain'))).toBeNull();
  });

  it('rejects unsupported, oversized, and empty files', () => {
    expect(validateMissionAttachment(file('notes.txt', 'text/plain'), [])).toMatch(/imagem/);
    expect(validateMissionAttachment(file('erro.png', 'image/png', 0), [])).toMatch(/vazio/);
    expect(validateMissionAttachment(file('erro.png', 'image/png', 15 * 1024 * 1024), [])).toMatch(/14 MB/);
  });

  it('builds a bounded context block for the mission agents', () => {
    expect(buildMissionAttachmentsContext([attachment])).toContain('erro.png');
    expect(buildMissionAttachmentsContext([])).toBe('');
  });
});
