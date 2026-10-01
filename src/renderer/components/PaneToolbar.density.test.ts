import { describe, expect, it } from 'vitest';
import {
  nextToolbarDensity,
  recordToolbarOverflow,
  TOOLBAR_DENSITY_HYSTERESIS_PX,
  type Density,
  type ToolbarNeeds,
} from './PaneToolbar';

describe('densidade do cabeçalho do pane com histerese (F-686)', () => {
  it('encolhe na hora ao cruzar o limite para baixo', () => {
    expect(nextToolbarDensity('full', 759)).toBe('icons');
    expect(nextToolbarDensity('icons', 359)).toBe('compact');
    expect(nextToolbarDensity('full', 300)).toBe('compact');
  });

  it('só volta a um modo mais largo com folga acima do limite', () => {
    expect(nextToolbarDensity('icons', 760)).toBe('icons');
    expect(nextToolbarDensity('icons', 760 + TOOLBAR_DENSITY_HYSTERESIS_PX - 1)).toBe('icons');
    expect(nextToolbarDensity('icons', 760 + TOOLBAR_DENSITY_HYSTERESIS_PX)).toBe('full');
    expect(nextToolbarDensity('compact', 360 + TOOLBAR_DENSITY_HYSTERESIS_PX)).toBe('icons');
    expect(nextToolbarDensity('compact', 2_000)).toBe('full');
  });

  it('barra de rolagem do Windows (±17 px) não faz o cabeçalho alternar a cada quadro', () => {
    // Gravação 29/09 18:08: a largura oscilava entre ~770 e ~753 conforme a
    // barra de rolagem da grade aparecia e sumia.
    let density: Density = 'full';
    const seen: Density[] = [];
    for (const width of [770, 753, 770, 753, 770, 753, 770]) {
      density = nextToolbarDensity(density, width);
      seen.push(density);
    }
    expect(seen).toEqual(['full', 'icons', 'icons', 'icons', 'icons', 'icons', 'icons']);
  });
});

describe('densidade pelo transbordo real da barra (F-717)', () => {
  it('guarda quanto a densidade pedia e ignora ruído de 1 px e o modo compacto', () => {
    expect(recordToolbarOverflow({}, 'full', 850, 1)).toEqual({});
    expect(recordToolbarOverflow({}, 'compact', 200, 40)).toEqual({});
    expect(recordToolbarOverflow({}, 'full', 850, 160.4)).toEqual({ full: 1011 });
    const needs: ToolbarNeeds = { full: 1011 };
    expect(recordToolbarOverflow(needs, 'full', 850, 100)).toBe(needs);
    expect(recordToolbarOverflow(needs, 'icons', 500, 40)).toEqual({ full: 1011, icons: 540 });
  });

  it('pane largo cuja barra cheia não cabe desce para ícones e só volta com folga', () => {
    // Print de 01/10: três panes de ~850 px, rótulos + custo + tok/s, Fechar cortado.
    const needs: ToolbarNeeds = { full: 1011 };
    expect(nextToolbarDensity('full', 850)).toBe('full');
    expect(nextToolbarDensity('full', 850, needs)).toBe('icons');
    expect(nextToolbarDensity('icons', 850, needs)).toBe('icons');
    expect(nextToolbarDensity('icons', 1011 + TOOLBAR_DENSITY_HYSTERESIS_PX - 1, needs)).toBe('icons');
    expect(nextToolbarDensity('icons', 1011 + TOOLBAR_DENSITY_HYSTERESIS_PX, needs)).toBe('full');
  });

  it('ícones que também não cabem descem até o compacto, que nunca transborda o Fechar', () => {
    const needs: ToolbarNeeds = { full: 1011, icons: 700 };
    expect(nextToolbarDensity('full', 650, needs)).toBe('compact');
    expect(nextToolbarDensity('compact', 700, needs)).toBe('compact');
    expect(nextToolbarDensity('compact', 700 + TOOLBAR_DENSITY_HYSTERESIS_PX, needs)).toBe('icons');
  });
});
