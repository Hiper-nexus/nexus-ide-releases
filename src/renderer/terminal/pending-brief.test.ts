import { describe, expect, it } from 'vitest';
import {
  MAX_BRIEF_CHARS,
  stashPendingBrief,
  takePendingBrief,
} from './pending-brief';
import {
  BRIEF_ATTACHMENT_KEY_MAX,
  BRIEF_FIELD_LIMITS,
  BRIEF_MAX_ATTACHMENTS,
  buildPresentationBrief,
} from '../components/video-brief';

/** O brief mais pesado que o formulário do Estúdio consegue montar. */
function worstCaseBrief(): string {
  return buildPresentationBrief({
    product: 'P'.repeat(BRIEF_FIELD_LIMITS.product),
    siteUrl: `https://${'a'.repeat(BRIEF_FIELD_LIMITS.siteUrl)}`,
    audience: 'u'.repeat(BRIEF_FIELD_LIMITS.audience),
    style: 's'.repeat(BRIEF_FIELD_LIMITS.style),
    durationSec: 90,
    preset: 'youtube-16x9',
    voice: { kind: 'mine', voiceId: 'x'.repeat(64), name: 'y'.repeat(120) },
    music: true,
    attachments: Array.from({ length: BRIEF_MAX_ATTACHMENTS }, () => ({
      // Papel de instrução mais longa + caminho acima do teto da linha.
      role: 'example-video' as const,
      storageKey: 'k'.repeat(BRIEF_ATTACHMENT_KEY_MAX + 50),
      name: 'exemplo.mp4',
    })),
  });
}

describe('brief pendente: o teto é guarda, não tesoura', () => {
  it('o pior brief que o formulário monta cabe inteiro no teto', () => {
    // Se alguém subir um teto de campo sem subir MAX_BRIEF_CHARS, é aqui que
    // aparece — antes de o agente receber um pedido sem o fim.
    expect(worstCaseBrief().length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
  });

  it('o fim do brief — a regra de custo — chega ao pane no pior caso', () => {
    // O corte é no FIM do texto: em 8.000 a trava de gasto sumia em silêncio
    // e o agente podia pagar API sem perguntar.
    stashPendingBrief('pane-pior-caso', worstCaseBrief());
    const delivered = takePendingBrief('pane-pior-caso');
    expect(delivered).toContain('me mostre o roteiro e o custo');
    expect(delivered).toContain('espere o meu ok');
    expect(delivered).toContain('nexus_video_export no preset youtube-16x9');
  });

  it('um roteiro de 1.800 caracteres chega inteiro ao agente', () => {
    const roteiro = 'R'.repeat(1_800);
    stashPendingBrief('pane-roteiro', buildPresentationBrief({
      product: roteiro,
      durationSec: 45,
      preset: 'vertical-9x16',
      voice: { kind: 'none' },
      music: false,
    }));
    expect(takePendingBrief('pane-roteiro')).toContain(`Produto: ${roteiro}`);
  });

  it('entrega uma vez só e some', () => {
    stashPendingBrief('pane-x', 'um pedido');
    expect(takePendingBrief('pane-x')).toBe('um pedido');
    expect(takePendingBrief('pane-x')).toBeUndefined();
  });

  it('texto em branco não vira brief', () => {
    stashPendingBrief('pane-vazio', '   \n  ');
    expect(takePendingBrief('pane-vazio')).toBeUndefined();
  });
});
