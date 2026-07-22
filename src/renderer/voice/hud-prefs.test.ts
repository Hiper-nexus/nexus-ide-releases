import { describe, expect, it } from 'vitest';
import {
  anchorFromDrag,
  clampHudWidth,
  DEFAULT_HUD_PREFS,
  HUD_EDGE_MARGIN,
  HUD_MAX_WIDTH,
  HUD_MIN_WIDTH,
  hudPositionStyle,
  isHudMini,
  loadHudPrefs,
  nearestCorner,
  saveHudPrefs,
} from './hud-prefs';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe('hud-prefs', () => {
  it('preserva o modo expandido quando a Jarvis está pronta para clique', () => {
    expect(isHudMini('expanded')).toBe(false);
    expect(isHudMini('mini')).toBe(true);
  });

  it('clampa a largura dentro dos limites', () => {
    expect(clampHudWidth(100)).toBe(HUD_MIN_WIDTH);
    expect(clampHudWidth(9999)).toBe(HUD_MAX_WIDTH);
    expect(clampHudWidth(320)).toBe(320);
    expect(clampHudWidth(Number.NaN)).toBe(DEFAULT_HUD_PREFS.width);
  });

  it('resolve o canto mais próximo pelos quadrantes do viewport', () => {
    expect(nearestCorner(10, 10, 1000, 800)).toBe('tl');
    expect(nearestCorner(990, 10, 1000, 800)).toBe('tr');
    expect(nearestCorner(10, 790, 1000, 800)).toBe('bl');
    expect(nearestCorner(990, 790, 1000, 800)).toBe('br');
  });

  it('ancora o drag no canto certo com offsets medidos daquele canto', () => {
    const vp = { width: 1000, height: 800 };
    // Solto perto do canto superior-esquerdo.
    expect(anchorFromDrag({ left: 30, top: 40, width: 300, height: 200 }, vp)).toEqual({
      corner: 'tl',
      dx: 30,
      dy: 40,
    });
    // Solto perto do canto inferior-direito: offsets viram distância da direita/baixo.
    expect(
      anchorFromDrag({ left: 660, top: 560, width: 300, height: 200 }, vp),
    ).toEqual({ corner: 'br', dx: 40, dy: 40 });
  });

  it('nunca ancora fora da tela (clamp na margem)', () => {
    const vp = { width: 1000, height: 800 };
    const anchored = anchorFromDrag(
      { left: -500, top: -500, width: 300, height: 200 },
      vp,
    );
    expect(anchored.corner).toBe('tl');
    expect(anchored.dx).toBe(HUD_EDGE_MARGIN);
    expect(anchored.dy).toBe(HUD_EDGE_MARGIN);
  });

  it('gera o estilo de posição fixa correto para cada canto', () => {
    expect(hudPositionStyle({ corner: 'tl', dx: 12, dy: 16 })).toEqual({
      left: 12,
      top: 16,
    });
    expect(hudPositionStyle({ corner: 'br', dx: 20, dy: 24 })).toEqual({
      right: 20,
      bottom: 24,
    });
    expect(hudPositionStyle({ corner: 'tr', dx: 8, dy: 8 })).toEqual({
      right: 8,
      top: 8,
    });
    expect(hudPositionStyle({ corner: 'bl', dx: 8, dy: 8 })).toEqual({
      left: 8,
      bottom: 8,
    });
  });

  it('faz round-trip de save/load', () => {
    const storage = fakeStorage();
    saveHudPrefs(storage, {
      mode: 'mini',
      corner: 'tr',
      dx: 32,
      dy: 48,
      width: 360,
    });
    expect(loadHudPrefs(storage)).toEqual({
      mode: 'mini',
      corner: 'tr',
      dx: 32,
      dy: 48,
      width: 360,
    });
  });

  it('volta aos defaults com storage vazio ou JSON inválido', () => {
    expect(DEFAULT_HUD_PREFS.mode).toBe('mini');
    expect(loadHudPrefs(fakeStorage())).toEqual(DEFAULT_HUD_PREFS);
    expect(
      loadHudPrefs(fakeStorage({ 'nexus.voiceHud': '{{{ lixo' })),
    ).toEqual(DEFAULT_HUD_PREFS);
  });

  it('sanitiza campos inválidos individualmente', () => {
    const storage = fakeStorage({
      'nexus.voiceHud': JSON.stringify({
        mode: 'giant',
        corner: 'center',
        dx: -50,
        dy: 'top',
        width: 10_000,
      }),
    });
    expect(loadHudPrefs(storage)).toEqual({
      ...DEFAULT_HUD_PREFS,
      width: HUD_MAX_WIDTH,
    });
  });
});
