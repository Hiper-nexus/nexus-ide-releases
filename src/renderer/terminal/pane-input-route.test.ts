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

  it('pane governado sem missão (papel de orquestração) usa a lane do operador', () => {
    // Campo 09/09: pane aberto pelo operador pede um pane ao agente
    // (nexus_pane_spawn) e o novo pane nasce worker/orchestrator SEM missão.
    // A lane crua é recusada pelo main para esses panes — a tecla do operador
    // morria em silêncio no pane que o orquestrador abriu.
    expect(
      paneInputLane({ kind: 'cli-agent', missionId: undefined, role: 'worker' }, undefined),
    ).toBe('operator');
    expect(
      paneInputLane(
        { kind: 'cli-agent', missionId: undefined, role: 'orchestrator' },
        undefined,
      ),
    ).toBe('operator');
  });

  it('shell plano e cli-agent sem missão e sem papel seguem na lane crua', () => {
    expect(paneInputLane({ kind: 'shell', missionId: undefined }, undefined)).toBe(
      'raw',
    );
    // Pane direto do operador (adapter escolhido no "+ Pane"): main minta
    // role `user` e a escrita crua é permitida — não há o que pedir.
    expect(
      paneInputLane({ kind: 'cli-agent', missionId: undefined }, undefined),
    ).toBe('raw');
    expect(
      paneInputLane(
        { kind: 'cli-agent', missionId: undefined, role: undefined },
        undefined,
      ),
    ).toBe('raw');
  });

  it('pane desconhecido cai na lane crua (sem autoridade para pedir)', () => {
    expect(paneInputLane(undefined, undefined)).toBe('raw');
  });
});
