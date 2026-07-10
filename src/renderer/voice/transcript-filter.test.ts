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

  it('descarta o boilerplate longo e combinado observado nos logs', () => {
    expect(
      isDiscardableTranscript(
        'Obrigado por assistir, se inscreva no canal e ative o sininho para receber notificações de novos vídeos.',
        { inConversation: true },
      ),
    ).toBe(true);
  });

  it('mantém respostas curtas legítimas em conversa ativa', () => {
    for (const reply of ['valeu', 'tchau', 'oi', 'obrigado']) {
      expect(isDiscardableTranscript(reply, { inConversation: true })).toBe(false);
    }
  });

  it('descarta artefatos duros mesmo em conversa', () => {
    for (const junk of [
      '.',
      '[risos]',
      '[música]',
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
    expect(stripWakeAckEcho('Jackson?', 'Patrão')).toBe('');
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

describe('C3 Fase 1 — fix real do "sim" seco: stripper consciente de confirmação pendente', () => {
  it('com pendência viva, "sim" seco sobrevive ao stripper (re-wake confirma)', () => {
    expect(stripWakeAckEcho('sim', 'patrão', { protectConfirmation: true })).toBe('sim');
    expect(
      isWakeAckOnlyTranscript('sim', 'patrão', { protectConfirmation: true }),
    ).toBe(false);
  });

  it('com pendência viva, "Hey Jarvis, sim" vira "sim" (invocação ainda é stripada)', () => {
    expect(
      stripWakeAckEcho('Hey Jarvis, sim', 'patrão', { protectConfirmation: true }),
    ).toBe('sim');
  });

  it('protege o "sim" seco também sem userName configurado', () => {
    expect(stripWakeAckEcho('sim', '', { protectConfirmation: true })).toBe('sim');
    expect(isWakeAckOnlyTranscript('sim', '', { protectConfirmation: true })).toBe(false);
  });

  it('SEM pendência (default), "sim" seco continua fail-safe: tratado como eco de ack', () => {
    expect(isWakeAckOnlyTranscript('sim', 'patrão')).toBe(true);
    expect(stripWakeAckEcho('sim', 'patrão')).toBe('');
  });

  it('PERIGO C3: eco do ack da JARVIS continua morto mesmo com pendência viva', () => {
    // "Pois não, patrão?" é o ack que a JARVIS realmente toca no wake.
    expect(
      isWakeAckOnlyTranscript('Pois não, patrão?', 'patrão', { protectConfirmation: true }),
    ).toBe(true);
    // "Sim, patrão" (ack nominal com vocativo) também continua stripado: só o
    // "sim" SECO — que a JARVIS nunca fala — é poupado.
    expect(
      stripWakeAckEcho('Sim, patrão', 'patrão', { protectConfirmation: true }),
    ).toBe('');
  });

  it('o caminho que já funcionava ("confirmo") não regride', () => {
    expect(isWakeAckOnlyTranscript('confirmo', 'patrão')).toBe(false);
    expect(stripWakeAckEcho('confirmo', 'patrão')).toBe('confirmo');
  });
});
