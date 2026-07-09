import { describe, expect, it } from 'vitest';
import {
  isDiscardableTranscript,
  isWakeAckOnlyTranscript,
  stripWakeAckEcho,
} from './transcript-filter';

describe('isDiscardableTranscript', () => {
  it('descarta alucinações clássicas em captura fria', () => {
    for (const ghost of [
      'you',
      'Thank you.',
      'obrigado',
      'valeu',
      'e aí',
      'oi',
      'Beijos.',
      'E já!',
      'Se inscreve no canal!',
    ]) {
      expect(isDiscardableTranscript(ghost, { inConversation: false })).toBe(true);
    }
  });

  it('mantém respostas curtas legítimas em conversa ativa', () => {
    for (const reply of ['valeu', 'tchau', 'oi', 'obrigado']) {
      expect(isDiscardableTranscript(reply, { inConversation: true })).toBe(false);
    }
  });

  it('descarta artefatos duros mesmo em conversa', () => {
    for (const junk of [
      '.',
      'amara.org',
      'obrigado por assistir',
      'se inscreve no canal',
      'ai ai',
      'hum',
    ]) {
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

  it('remove "E aí, Jarvis?" prefixado pelo Classic STT no mesmo utterance', () => {
    expect(stripWakeAckEcho('E aí, Jarvis? Abrir novo o Workspace.', 'patrão')).toBe(
      'Abrir novo o Workspace.',
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

describe('C3 item 7 — pin do fix-followups: "sim" seco morre no stripper de eco do ack', () => {
  it('LIMITAÇÃO CONHECIDA: "sim" isolado é tratado como ack/wake (comportamento atual, fail-safe)', () => {
    expect(isWakeAckOnlyTranscript('sim', 'patrão')).toBe(true);
  });

  it('o caminho que FUNCIONA ("confirmo") não regride: sobrevive ao stripper', () => {
    expect(isWakeAckOnlyTranscript('confirmo', 'patrão')).toBe(false);
    expect(stripWakeAckEcho('confirmo', 'patrão')).toBe('confirmo');
  });
});
