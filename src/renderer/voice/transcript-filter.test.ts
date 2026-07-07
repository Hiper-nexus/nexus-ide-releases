import { describe, expect, it } from 'vitest';
import {
  isDiscardableTranscript,
  isWakeAckOnlyTranscript,
  stripWakeAckEcho,
} from './transcript-filter';

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
    for (const junk of ['.', 'amara.org', 'obrigado por assistir', 'ai ai', 'hum']) {
      expect(isDiscardableTranscript(junk, { inConversation: true })).toBe(true);
    }
  });

  it('descarta vazio/espaços em qualquer contexto', () => {
    expect(isDiscardableTranscript('   ', { inConversation: true })).toBe(true);
    expect(isDiscardableTranscript('', { inConversation: false })).toBe(true);
  });

  it('descarta eco da própria JARVIS em conversa', () => {
    expect(isDiscardableTranscript('não entendi o pedido', { inConversation: true })).toBe(
      true,
    );
    expect(isDiscardableTranscript('pode repetir', { inConversation: true })).toBe(true);
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

describe('stripWakeAckEcho', () => {
  it('remove invocação e ack do pre-roll antes do comando', () => {
    expect(stripWakeAckEcho('Hey Jarvis, pois não, patrão, abrir terminal', 'patrão'))
      .toBe('abrir terminal');
  });

  it('descarta ack puro vazado pelo alto-falante', () => {
    expect(stripWakeAckEcho('Pois não, patrão?', 'patrão')).toBe('');
    expect(stripWakeAckEcho('Estou ouvindo.', 'patrão')).toBe('');
    expect(stripWakeAckEcho('E Javes Pois não, Patrão', 'Patrão')).toBe('');
    expect(stripWakeAckEcho('Pues no patrón.', 'Patrão')).toBe('');
  });

  it('não mexe em fala real sem prefixo de wake', () => {
    expect(stripWakeAckEcho('abre o terminal agora', 'patrão')).toBe(
      'abre o terminal agora',
    );
  });
});

describe('isWakeAckOnlyTranscript', () => {
  it('marca eco de ack sem comando', () => {
    expect(isWakeAckOnlyTranscript('Pois não, patrão?', 'patrão')).toBe(true);
    expect(isWakeAckOnlyTranscript('Pues no patrón.', 'Patrão')).toBe(true);
    expect(isWakeAckOnlyTranscript('abrir terminal', 'patrão')).toBe(false);
  });
});
