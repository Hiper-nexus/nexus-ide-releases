import { describe, expect, it } from 'vitest';
import { inferWorkerDecisionGuidance } from './worker-decision-guidance';

/** Exact shape of the HiperGO gate handoff the field hit. */
const HIPERGO_GATE_DETAIL =
  'blocked: Bloqueado antes da implementação: a governança do repositório autoriza apenas a Story 1.3 (status review) em RU-03-auth-identity e exige revisão/aceite antes de iniciar 1.4. A Story 1.4 está backlog em sprint-status.yaml e a matriz DELIVERY-COVERAGE-MATRIX.yaml marca release_unit UNASSIGNED, coverage_state UNASSIGNED, acceptance_ids [] e decision_ids []; não existe story spec/manifest de implementação para ela. Além disso, o checkout já está sujo com alterações preexistentes em services/api/internal/auth/handler.go e services/api/internal/platform/config/config.go, impedindo o commit seguro solicitado sem misturar trabalho. Decisão necessária: (1) atualizar/autorizAR formalmente a RU e fornecer o contrato/manifest da Story 1.4, além de indicar como preservar ou assumir as alterações locais; ou (2) direcionar a revisão/aceite da Story 1.3 como próximo trabalho.';

describe('inferWorkerDecisionGuidance', () => {
  it('HiperGO: 1.4 bloqueada, 1.3 autorizada — NUNCA inverte', () => {
    const guidance = inferWorkerDecisionGuidance(HIPERGO_GATE_DETAIL);

    expect(guidance.summary).toMatch(/1\.4/i);
    expect(guidance.summary).toMatch(/1\.3/i);
    expect(guidance.summary).not.toMatch(/Story 1\.3 não está liberada/i);
    expect(guidance.question).toMatch(/1\.4/i);
    expect(guidance.question).toMatch(/1\.3/i);
    expect(guidance.question).not.toMatch(/Story 1\.3 foi recusada/i);

    const join = guidance.options.join(' | ');
    expect(join).toMatch(/Continuar com a Story 1\.3/i);
    expect(join).toMatch(/Liberar a Story 1\.4/i);
    expect(join).toMatch(/Encerrar/i);
    // Must not tell the operator to "keep 1.3 and fix the gate" as if 1.3 were blocked.
    expect(join).not.toMatch(/Manter a Story 1\.3 — vou ajustar/i);
  });

  it('extrai fork story 1.4 backlog vs 1.3 autorizada (ordem invertida no texto)', () => {
    const detail =
      'blocked: Story 1.4 está backlog, sem story spec, e AGENTS.md autorizam somente a Story 1.3 em review.';

    const guidance = inferWorkerDecisionGuidance(detail);

    expect(guidance.options.some((o) => /Continuar com a Story 1\.3/i.test(o))).toBe(
      true,
    );
    expect(guidance.options.some((o) => /Liberar a Story 1\.4/i.test(o))).toBe(true);
  });

  it('usa caminhos numerados do worker quando o fork de story não fecha', () => {
    const detail =
      'blocked: preciso de decisão do operador.\n' +
      '(1) seguir com a abordagem A no módulo de billing\n' +
      '(2) adiar billing e focar no dashboard\n' +
      '(3) cancelar o pacote';

    const guidance = inferWorkerDecisionGuidance(detail);

    expect(guidance.options[0]).toMatch(/billing/i);
    expect(guidance.options.length).toBeGreaterThanOrEqual(2);
  });

  it('fallback genérico sem inventar story', () => {
    const guidance = inferWorkerDecisionGuidance(
      'blocked: credencial do provedor externo indisponível para o passo X.',
    );

    expect(guidance.question).toMatch(/decisão/i);
    expect(guidance.options).toContain('Encerrar a missão por agora');
    expect(guidance.options.some((o) => /story/i.test(o))).toBe(false);
  });
});
