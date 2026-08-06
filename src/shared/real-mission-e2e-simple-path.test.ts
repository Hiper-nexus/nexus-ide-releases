import { describe, expect, it } from 'vitest';
import {
  REAL_MISSION_E2E_ACCEPTANCE_CRITERIA,
  realMissionE2EExpectedTaskChain,
} from './real-mission-e2e-contract';

/**
 * O contrato do gate tem de provar o MUNDO NOVO, não a ausência do antigo.
 *
 * O gate roda uma missão REAL contra o app empacotado; se ele ainda esperasse
 * modal de aprovação ou a forma isolada, falharia porque o TESTE está velho —
 * não porque o produto quebrou (foi assim que queimamos cinco rodadas na
 * 0.26.0). Estas asserções fixam as garantias da 0.27.0.
 */
describe('contrato do gate — garantias da 0.27.0', () => {
  const chain = realMissionE2EExpectedTaskChain(['codex']);
  const execution = chain.find((member) => member.kind === 'execution');

  it('a entrega roda no próprio workspace (caminho simples)', () => {
    expect(execution).toBeDefined();
    expect(execution!.executionMode).toBe('same_checkout');
    expect(execution!.plannerId).toBe('guided-execution');
  });

  it('nenhum membro da cadeia depende de aprovação humana', () => {
    const texto = JSON.stringify(chain).toLowerCase();
    expect(texto).not.toContain('awaiting_approval');
    expect(texto).not.toContain('aprovacao_pendente');
  });

  it('os invariantes de aceite não mencionam modal de aprovação', () => {
    const invariantes = REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.join(' | ');
    expect(invariantes).not.toMatch(/modal de aprova/i);
    // E dizem a verdade nova: entrega no próprio workspace.
    expect(invariantes).toMatch(/pr[óo]prio workspace/i);
  });

  it('o receipt de validação admite a forma same_checkout', () => {
    const invariantes = REAL_MISSION_E2E_ACCEPTANCE_CRITERIA.join(' | ');
    expect(invariantes).toContain('same_checkout_validated');
  });

  it('os revisores continuam read_only — leitor nunca vira escritor', () => {
    const leitores = chain.filter((member) => member.kind !== 'execution');
    expect(leitores.length).toBeGreaterThan(0);
    for (const leitor of leitores) {
      expect(leitor.executionMode).toBe('read_only');
    }
  });
});
