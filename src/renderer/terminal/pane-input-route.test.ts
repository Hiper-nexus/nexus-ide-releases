import { describe, expect, it } from 'vitest';
import { paneInputLane } from './pane-input-route';

describe('paneInputLane — mesma lane do teclado para QUALQUER escrita no pane', () => {
  it('pane governado (cli-agent com missão) usa a lane do operador', () => {
    // BUG 1 do voo real 06/08: o espaço retido do toque rápido era emitido
    // pela lane crua (writeToPane → pty.write), que o main RECUSA para
    // agentes orquestrados — o espaço morria em silêncio no pane de missão.
    expect(
      paneInputLane({ kind: 'cli-agent', missionId: 'mission-1' }, undefined),
    ).toBe('operator');
  });

  it('vínculo de missão vindo do orchStore também governa', () => {
    expect(
      paneInputLane({ kind: 'cli-agent', missionId: undefined }, 'mission-2'),
    ).toBe('operator');
  });

  it('shell plano e cli-agent sem missão seguem na lane crua', () => {
    expect(paneInputLane({ kind: 'shell', missionId: undefined }, undefined)).toBe(
      'raw',
    );
    expect(
      paneInputLane({ kind: 'cli-agent', missionId: undefined }, undefined),
    ).toBe('raw');
  });

  it('pane desconhecido cai na lane crua (sem autoridade para pedir)', () => {
    expect(paneInputLane(undefined, undefined)).toBe('raw');
  });
});
