import { describe, expect, it } from 'vitest';
import { nextToolbarDensity, TOOLBAR_DENSITY_HYSTERESIS_PX, type Density } from './PaneToolbar';

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
