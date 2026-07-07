import { describe, expect, it } from 'vitest';
import {
  isConfusionReply,
  noteAutoReplyOpened,
  resetAutoReplyLoop,
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

  it('não reabre em respostas de confusão', () => {
    resetAutoReplyLoop();
    expect(isConfusionReply('Não entendi o pedido, patrão.')).toBe(true);
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Não entendi o pedido, patrão.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(false);
  });

  it('trava após muitas reaberturas seguidas', () => {
    resetAutoReplyLoop();
    for (let i = 0; i < 5; i += 1) noteAutoReplyOpened();
    expect(
      shouldReopenJarvisListening({
        expectReply: true,
        sayText: 'Me conta mais.',
        realtimeTurnActive: false,
        isRealtimeLive: false,
      }),
    ).toBe(false);
  });
});
