/**
 * O gate recusa na pressão CRÍTICA mesmo para a mão do operador (19/10).
 *
 * Doutrina "menos travas" (16/09): contagem de panes não é dano nomeado, então
 * o teto AVISA. Mas a própria doutrina diz "bloqueio só por pressão real" — e
 * a pressão crítica medida é exatamente isso. Medido num Mac de 16 GB: teto 4,
 * `hardBlocks` false, 8 panes vivos e 500 MB livres → o gate devolvia
 * `ok: true`. O cliente do iMac M5 abriu panes até o macOS travar inteiro.
 *
 * O que NÃO muda: moderada e severa seguem avisando, e `NEXUS_PANE_GUARD=off`
 * / `NEXUS_PANE_MIN_FREE_MB=0` continuam desligando tudo.
 */
import { describe, expect, it } from 'vitest';
import {
  CRITICAL_PRESSURE_FREE_RATIO,
  evaluatePaneAdmission,
  isCriticalMemoryPressureSample,
  limitsForMachine,
  readPaneAdmissionLimits,
  type PaneAdmissionLimits,
} from './pane-admission';

const MAC_16GB = 16 * 1024;
const limits16 = (): PaneAdmissionLimits => limitsForMachine(MAC_16GB, 'darwin');

function verdictAt(freeMB: number, overrides: Partial<Parameters<typeof evaluatePaneAdmission>[0]> = {}) {
  return evaluatePaneAdmission({
    liveAgentPanes: 8,
    limits: limits16(),
    memory: { freeMB, swapUsedMB: null },
    idleCandidates: [],
    ...overrides,
  });
}

describe('gate de admissão: pressão crítica recusa até a mão do operador', () => {
  it('o Mac de 16 GB tem teto 4 e reserva de 2458 MB (régua medida)', () => {
    const limits = limits16();
    expect(limits.maxAgentPanes).toBe(4);
    expect(limits.minFreeMB).toBe(2458);
    expect(limits.hardBlocks).toBe(false);
  });

  it('CRÍTICA (500 MB livres): recusa por memória e nomeia o dano e o caminho', () => {
    const verdict = verdictAt(500);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('memory');
    expect(verdict.message).toMatch(/trav/i);
  });

  it('recusa já no primeiro pane se a máquina está crítica por outros apps', () => {
    const verdict = verdictAt(400, { liveAgentPanes: 0 });
    expect(verdict.ok).toBe(false);
  });

  it('SEVERA e MODERADA continuam AVISANDO (doutrina "menos travas")', () => {
    for (const freeMB of [1000, 2000]) {
      const verdict = verdictAt(freeMB);
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.warning).toBeTruthy();
    }
  });

  it('com folga não recusa nem avisa por memória', () => {
    const verdict = verdictAt(9000, { liveAgentPanes: 1 });
    expect(verdict.ok).toBe(true);
  });

  it('NEXUS_PANE_GUARD=off desliga até a recusa crítica', () => {
    const limits = readPaneAdmissionLimits({ NEXUS_PANE_GUARD: 'off' }, MAC_16GB, 'darwin');
    const verdict = evaluatePaneAdmission({
      liveAgentPanes: 20,
      limits,
      memory: { freeMB: 100, swapUsedMB: null },
      idleCandidates: [],
    });
    expect(verdict.ok).toBe(true);
  });

  it('NEXUS_PANE_MIN_FREE_MB=0 zera o limiar: nunca fica crítico', () => {
    const limits = readPaneAdmissionLimits({ NEXUS_PANE_MIN_FREE_MB: '0' }, MAC_16GB, 'darwin');
    expect(isCriticalMemoryPressureSample({ freeMB: 10, swapUsedMB: null }, limits)).toBe(false);
    const verdict = evaluatePaneAdmission({
      liveAgentPanes: 9,
      limits,
      memory: { freeMB: 10, swapUsedMB: null },
      idleCandidates: [],
    });
    expect(verdict.ok).toBe(true);
  });

  it('isCriticalMemoryPressureSample usa 30 % da reserva e ignora amostra ausente', () => {
    const limits = limits16();
    const threshold = limits.minFreeMB * CRITICAL_PRESSURE_FREE_RATIO;
    expect(isCriticalMemoryPressureSample({ freeMB: threshold - 1, swapUsedMB: null }, limits)).toBe(true);
    expect(isCriticalMemoryPressureSample({ freeMB: threshold + 1, swapUsedMB: null }, limits)).toBe(false);
    expect(isCriticalMemoryPressureSample(null, limits)).toBe(false);
    expect(isCriticalMemoryPressureSample({ freeMB: null, swapUsedMB: 99_999 }, limits)).toBe(false);
  });

  it('worker automático continua recusado na crítica (sem regressão do F-784)', () => {
    const verdict = verdictAt(500, { automaticWorker: true });
    expect(verdict.ok).toBe(false);
  });
});
