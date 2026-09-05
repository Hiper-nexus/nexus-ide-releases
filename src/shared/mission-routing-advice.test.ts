import { describe, expect, it } from 'vitest';
import { compileIntentContract, missionIntentContractSchema } from './mission-intent';
import {
  getMissionRoutingHints,
  missionRoutingAdviceSchema,
  missionRoutingReviewWarnings,
  parseMissionRoutingAdvice,
  type MissionRoutingAdvice,
} from './mission-routing-advice';

describe('mission routing advice contract', () => {
  it('keeps older contracts readable with no routing behavior added', () => {
    const contract = compileIntentContract({ goal: 'Corrija o checkout.', intentVersion: 1 });

    expect(missionIntentContractSchema.parse(contract).routingAdvice).toBeUndefined();
    expect(getMissionRoutingHints(contract)).toEqual({
      paneQuestion: null, readOnlyWorkers: false, suggestedSkills: [],
    });
    expect(missionRoutingReviewWarnings(undefined)).toEqual([]);
  });

  it('retains a classified pane question in the persisted contract for dispatch', () => {
    const routingAdvice: MissionRoutingAdvice = {
      source: 'router', kind: 'mission-question',
      question: 'Qual teste reproduz o defeito?', readOnlyWorkers: true,
    };
    const contract = missionIntentContractSchema.parse({
      ...compileIntentContract({ goal: 'Consolide as opiniões da equipe.', intentVersion: 1 }),
      routingAdvice,
    });

    expect(contract.routingAdvice).toEqual(routingAdvice);
    expect(getMissionRoutingHints(contract)).toEqual({
      paneQuestion: 'Qual teste reproduz o defeito?', readOnlyWorkers: true, suggestedSkills: [],
    });
  });

  it('does not turn a general question or unavailable classifier into a pane ASK', () => {
    const general = parseMissionRoutingAdvice({
      kind: 'direct-answer', question: 'O que é Git?',
    }, null);

    expect(general).toEqual({ source: 'router', kind: 'direct-answer', question: 'O que é Git?' });
    expect(missionRoutingReviewWarnings(general).join('\n')).toContain('pergunta geral');
    for (const advice of [general, parseMissionRoutingAdvice(null, null)]) {
      expect(getMissionRoutingHints({ routingAdvice: advice })).toEqual({
        paneQuestion: null, readOnlyWorkers: false, suggestedSkills: [],
      });
    }
  });

  it('narrows skill hints again for the individual worker without changing the saved advice', () => {
    const routingAdvice: MissionRoutingAdvice = {
      source: 'router', kind: 'mission-work', skills: ['impeccable', 'bridgesecurity'],
    };

    expect(getMissionRoutingHints({ routingAdvice }, ['bridgesecurity']).suggestedSkills).toEqual(['bridgesecurity']);
    expect(getMissionRoutingHints({ routingAdvice }, []).suggestedSkills).toEqual([]);
    expect(getMissionRoutingHints({ routingAdvice }, null).suggestedSkills).toEqual(['impeccable', 'bridgesecurity']);
    expect(routingAdvice.skills).toEqual(['impeccable', 'bridgesecurity']);
  });

  it('filters unreviewed names even when the roster permits any skill', () => {
    expect(parseMissionRoutingAdvice({
      kind: 'mission-work', skills: ['shell-admin', 'impeccable', 'impeccable'],
    }, null)).toEqual({ source: 'router', kind: 'mission-work', skills: ['impeccable'] });
  });

  it.each([
    { source: 'router', kind: 'mission-question', question: 'Pergunta', readOnlyWorkers: false },
    { source: 'router', kind: 'mission-question', question: 'x'.repeat(4_097), readOnlyWorkers: true },
    { source: 'router', kind: 'mission-work', skills: ['shell-admin'] },
    { source: 'router', kind: 'mission-work', skills: [], allowedTools: null },
    { source: 'model', kind: 'mission-work', skills: [] },
  ])('rejects invalid persisted advice and yields no dispatch hints: %j', (value) => {
    expect(missionRoutingAdviceSchema.safeParse(value).success).toBe(false);
    expect(getMissionRoutingHints({ routingAdvice: value as MissionRoutingAdvice })).toEqual({
      paneQuestion: null, readOnlyWorkers: false, suggestedSkills: [],
    });
  });
});
