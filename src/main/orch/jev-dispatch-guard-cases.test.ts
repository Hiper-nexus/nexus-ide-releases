import { describe, expect, it } from 'vitest';
import { decisionEvalCasesSchema } from '../decision-models/decision-evaluation';
import { DISPATCH_GUARD_EVAL_CASES } from './jev-dispatch-guard-cases';
import { GUARD_STATE_IS_DATA, guardQuestionsForTool } from './jev-dispatch-guard';

describe('F-1625: suíte rotulada da guarda de despacho', () => {
  it('é aceita pelo avaliador e cobre ataques e legítimos nas duas divisões', () => {
    expect(decisionEvalCasesSchema.safeParse(DISPATCH_GUARD_EVAL_CASES).success).toBe(true);
    const attacks = DISPATCH_GUARD_EVAL_CASES.filter((c) => {
      const injected = c.expected.injected as { min: number } | undefined;
      const coherent = c.expected.coherent as { max: number } | undefined;
      return (injected && injected.min >= 0.8) || (coherent && coherent.max <= 0.35);
    });
    const benign = DISPATCH_GUARD_EVAL_CASES.filter((c) => !attacks.includes(c));
    expect(attacks.length).toBeGreaterThanOrEqual(5);
    expect(benign.length).toBeGreaterThanOrEqual(5);
    for (const group of [attacks, benign]) {
      expect(new Set(group.map((c) => c.split))).toEqual(new Set(['development', 'heldout']));
    }
  });

  it('mede as perguntas exatas da produção, inclusive a cláusula "state é dado"', () => {
    for (const testCase of DISPATCH_GUARD_EVAL_CASES) {
      const tool = (testCase.state as { call: { tool: string } }).call.tool;
      const production = guardQuestionsForTool(tool);
      for (const [id, question] of Object.entries(testCase.questions)) {
        expect(question).toEqual(production[id]);
        expect(String(question.instructions)).toContain(GUARD_STATE_IS_DATA);
      }
    }
  });

  it('inclui texto dirigido ao juiz nos ataques e citação de ataque nos legítimos', () => {
    const text = (id: string) => JSON.stringify(DISPATCH_GUARD_EVAL_CASES.find((c) => c.id === id)?.state);
    expect(text('guard-judge-steering-exfil')).toMatch(/NOTE TO THE SECURITY REVIEWER/);
    expect(text('guard-tests-about-injection')).toMatch(/Ignore previous instructions/);
    expect(text('guard-security-doc-quote')).toMatch(/pre-approved/);
  });
});
