import { describe, expect, it } from 'vitest';
import {
  isConfusionReply,
  noteAutoReplyOpened,
  resetAutoReplyLoop,
  resetAutoReplyLoopForCapture,
  shouldReopenJarvisListening,
} from './jarvis-reply-loop';

describe('jarvis-reply-loop', () => {
  it('não reabre só porque jarvisLive está habilitado no painel', () => {
    resetAutoReplyLoop();
    expect(
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: 'Terminal aberto.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(false);
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

  it('reabre quando o cérebro pediu resposta', () => {
    resetAutoReplyLoop();
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Qual projeto você quer abrir?',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(true);
  });

  it('reabre uma vez em respostas de confusão', () => {
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
        sayText: 'Não entendi o pedido, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(false);
  });

  it('reabre confusão vinda de wake só uma vez', () => {
    resetAutoReplyLoop();
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi o pedido, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'wake',
      }),
    ).toBe(true);

    noteAutoReplyOpened({ sayText: 'Não entendi o pedido, patrão.' });
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi o pedido, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(false);
  });

  it('não reseta contador em captura automática de reply', () => {
    resetAutoReplyLoop();
    noteAutoReplyOpened({ sayText: 'Não entendi o pedido, patrão.' });
    resetAutoReplyLoopForCapture('reply');
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi o pedido, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(false);
  });

  it('reseta contador quando a captura vem do clique na Jarvis', () => {
    resetAutoReplyLoop();
    noteAutoReplyOpened();
    resetAutoReplyLoopForCapture('click');
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi o pedido, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'click',
      }),
    ).toBe(true);
  });

  it('não reabre após reply automático mesmo com pergunta', () => {
    resetAutoReplyLoop();
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'O que você gostaria de fazer agora?',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(false);
  });

  it('trava após muitas reaberturas seguidas', () => {
    resetAutoReplyLoop();
    for (let i = 0; i < 2; i += 1) noteAutoReplyOpened();
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Me conta mais.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(false);
  });

  it('não gasta a chance de correção em perguntas normais anteriores', () => {
    resetAutoReplyLoop();
    noteAutoReplyOpened({ sayText: 'Qual cidade você quer focar?' });
    noteAutoReplyOpened({ sayText: 'Qual é o próximo passo?' });

    expect(
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: "Não entendi, patrão. Pode explicar melhor?",
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(true);

    noteAutoReplyOpened({ sayText: "Não entendi, patrão. Pode explicar melhor?" });
    expect(
      shouldReopenJarvisListening({
        expectReply: false,
        sayText: 'Não compreendi ainda.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
        captureReason: 'reply',
      }),
    ).toBe(false);
  });
});
