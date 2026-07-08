import { describe, expect, it } from 'vitest';
import {
  isConfusionReply,
  MAX_AUTO_REPLY_LOOPS,
  noteAutoReplyOpened,
  resetAutoReplyLoop,
  resetAutoReplyLoopForCapture,
  shouldReopenJarvisListening,
} from './jarvis-reply-loop';

describe('jarvis-reply-loop (continuidade)', () => {
  it('mantém a escuta quente após uma resposta comum (sem pergunta)', () => {
    resetAutoReplyLoop();
    // Antes exigia pergunta; agora a conversa segue quente por padrão.
    expect(
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: 'Terminal aberto.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(true);
  });

  it('reabre após wake quando a resposta pede continuidade', () => {
    resetAutoReplyLoop();
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'O que você precisa?',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'wake',
      }),
    ).toBe(true);
  });

  it('encadeia reply→reply para uma conversa contínua', () => {
    resetAutoReplyLoop();
    for (let turn = 0; turn < 5; turn += 1) {
      expect(
        shouldReopenJarvisListening({
          expectReply: false,
          sayText: 'Feito, patrão.',
          realtimeTurnActive: false,
          isRealtimeLive: false,
          captureReason: 'reply',
        }),
      ).toBe(true);
      noteAutoReplyOpened({ sayText: 'Feito, patrão.' });
    }
  });

  it('trava no teto de continuidade e exige novo Hey Jarvis', () => {
    resetAutoReplyLoop();
    for (let i = 0; i < MAX_AUTO_REPLY_LOOPS; i += 1) {
      noteAutoReplyOpened({ sayText: 'Feito.' });
    }
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Me conta mais.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(false);
  });

  it('sustenta ao menos 10 turnos sem re-wake antes do teto', () => {
    resetAutoReplyLoop();
    let reopens = 0;
    while (
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: 'Certo.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: reopens === 0 ? 'wake' : 'reply',
      })
    ) {
      reopens += 1;
      noteAutoReplyOpened({ sayText: 'Certo.' });
      if (reopens > 50) break; // guarda contra loop infinito no teste
    }
    expect(reopens).toBeGreaterThanOrEqual(10);
  });

  it('reabre confusão só uma vez para o usuário corrigir', () => {
    resetAutoReplyLoop();
    expect(isConfusionReply('Não entendi o pedido, patrão.')).toBe(true);
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi o pedido, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(true);

    noteAutoReplyOpened({ sayText: 'Não entendi o pedido, patrão.' });
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi de novo, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(false);
  });

  it('uma resposta comum reseta a contagem de confusão consecutiva', () => {
    resetAutoReplyLoop();
    noteAutoReplyOpened({ sayText: 'Não entendi, patrão.' }); // confusão 1
    noteAutoReplyOpened({ sayText: 'Abrindo o terminal.' }); // comum → zera confusão
    // Nova confusão volta a ser permitida uma vez.
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(true);
  });

  it('não reseta o contador em captura automática de reply', () => {
    resetAutoReplyLoop();
    noteAutoReplyOpened({ sayText: 'Feito.' });
    resetAutoReplyLoopForCapture('reply'); // reply NÃO reseta
    // Ainda dentro do teto, então segue reabrindo.
    expect(
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: 'Feito.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(true);
  });

  it('reseta o contador quando a captura vem do clique na Jarvis', () => {
    resetAutoReplyLoop();
    for (let i = 0; i < MAX_AUTO_REPLY_LOOPS; i += 1) noteAutoReplyOpened({ sayText: 'Feito.' });
    resetAutoReplyLoopForCapture('click'); // wake/click/manual/ptt zeram
    expect(
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: 'Feito.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'click',
      }),
    ).toBe(true);
  });

  it('com Live dono da sessão NÃO reabre Classic (P1 — evita racer)', () => {
    resetAutoReplyLoop();
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Feito.',
        realtimeTurnActive: true,
        isRealtimeLive: true,
        captureReason: 'reply',
      }),
    ).toBe(false);
  });

  it('Classic com expectReply=false ainda reabre (continuidade hot-listen)', () => {
    resetAutoReplyLoop();
    expect(
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: 'Feito.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'wake',
      }),
    ).toBe(true);
  });
});
