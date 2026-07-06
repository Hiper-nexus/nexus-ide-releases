import { describe, expect, it } from 'vitest';
import { isDiscardableTranscript } from './transcript-filter';

describe('isDiscardableTranscript', () => {
  it('descarta alucinações clássicas em captura fria', () => {
    for (const ghost of ['you', 'Thank you.', 'obrigado', 'valeu', 'e aí', 'oi']) {
      expect(isDiscardableTranscript(ghost, { inConversation: false })).toBe(true);
    }
  });

  it('mantém respostas curtas legítimas em conversa ativa', () => {
    for (const reply of ['valeu', 'tchau', 'oi', 'obrigado']) {
      expect(isDiscardableTranscript(reply, { inConversation: true })).toBe(false);
    }
  });

  it('descarta artefatos duros mesmo em conversa', () => {
    for (const junk of ['.', 'amara.org', 'obrigado por assistir']) {
      expect(isDiscardableTranscript(junk, { inConversation: true })).toBe(true);
    }
  });

  it('descarta vazio/espaços em qualquer contexto', () => {
    expect(isDiscardableTranscript('   ', { inConversation: true })).toBe(true);
    expect(isDiscardableTranscript('', { inConversation: false })).toBe(true);
  });

  it('nunca descarta fala real', () => {
    expect(
      isDiscardableTranscript('abre o terminal', { inConversation: false }),
    ).toBe(false);
    expect(
      isDiscardableTranscript('roda os testes', { inConversation: true }),
    ).toBe(false);
  });

  it('normaliza caixa e espaços antes de comparar', () => {
    expect(isDiscardableTranscript('  THANK   YOU  ', { inConversation: false })).toBe(
      true,
    );
  });
});
