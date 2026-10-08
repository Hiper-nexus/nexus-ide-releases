/** @vitest-environment jsdom */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as hudPrefs from './hud-prefs';

// F-1005 (10): o orbe da Jarvis e o "+ Pane" flutuam no canto inferior
// direito. Quem tem controle encostado ali reserva o espaço que o orbe ocupa
// de verdade — o orbe nunca some para "resolver" a sobreposição.
type SafeAreaApi = {
  floatingSafeArea(
    rect: { left: number; top: number; width: number; height: number },
    viewport: { width: number; height: number },
    corner: hudPrefs.HudCorner,
  ): { inline: number; block: number };
  publishFloatingSafeArea(
    root: HTMLElement,
    area: { inline: number; block: number } | null,
  ): void;
  FLOATING_SAFE_GAP: number;
};
const api = hudPrefs as unknown as Partial<SafeAreaApi>;

describe('F-1005 — área segura dos flutuantes', () => {
  it('o orbe padrão mora na faixa do canto, alinhado ao "+ Pane", não no meio do conteúdo', () => {
    expect(hudPrefs.DEFAULT_HUD_PREFS.corner).toBe('br');
    // 96 px deixava o orbe no meio de listas e cards (Atalhos, aprovação).
    expect(hudPrefs.DEFAULT_HUD_PREFS.dy).toBeLessThanOrEqual(16);
    expect(hudPrefs.DEFAULT_HUD_PREFS.dx).toBeLessThanOrEqual(16);
  });

  it('mede a reserva a partir do retângulo real do orbe ancorado embaixo à direita', () => {
    expect(typeof api.floatingSafeArea).toBe('function');
    const viewport = { width: 1280, height: 820 };
    const orb = { left: 1232, top: 772, width: 36, height: 36 };
    const gap = api.FLOATING_SAFE_GAP ?? 0;
    expect(gap).toBeGreaterThan(0);
    expect(api.floatingSafeArea!(orb, viewport, 'br')).toEqual({
      inline: 1280 - 1232 + gap,
      block: 820 - 772 + gap,
    });
    // Ancorado em outro canto o orbe não tampa a faixa de baixo à direita.
    expect(api.floatingSafeArea!(orb, viewport, 'tl')).toEqual({ inline: 0, block: 0 });
  });

  it('publica a reserva como variáveis CSS na raiz e limpa quando o orbe some', () => {
    expect(typeof api.publishFloatingSafeArea).toBe('function');
    const root = document.createElement('div');
    api.publishFloatingSafeArea!(root, { inline: 56, block: 56 });
    expect(root.style.getPropertyValue('--nexus-orb-safe-inline')).toBe('56px');
    expect(root.style.getPropertyValue('--nexus-orb-safe-block')).toBe('56px');
    api.publishFloatingSafeArea!(root, null);
    expect(root.style.getPropertyValue('--nexus-orb-safe-inline')).toBe('');
    expect(root.style.getPropertyValue('--nexus-orb-safe-block')).toBe('');
  });

  it('o VoiceHud publica a reserva medida', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'VoiceHud.tsx'),
      'utf-8',
    );
    expect(source).toContain('publishFloatingSafeArea(');
    expect(source).toContain('floatingSafeArea(');
  });
});
