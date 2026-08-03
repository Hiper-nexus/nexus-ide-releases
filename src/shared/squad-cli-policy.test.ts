import { describe, expect, it } from 'vitest';
import {
  isGovernedPolicy,
  isOperatorChoicePolicy,
  normalizeSquadCliPolicyInput,
  squadCliPolicyLabel,
} from './squad-cli-policy';

describe('squad-cli-policy', () => {
  it('treats only explicit governed as Hardened; everything else is Autopilot', () => {
    expect(isOperatorChoicePolicy('operator-choice')).toBe(true);
    expect(isOperatorChoicePolicy(undefined)).toBe(true);
    expect(isOperatorChoicePolicy(null)).toBe(true);
    expect(isOperatorChoicePolicy('yolo')).toBe(true);
    expect(isOperatorChoicePolicy('')).toBe(true);
    expect(isOperatorChoicePolicy('governed')).toBe(false);

    expect(isGovernedPolicy('governed')).toBe(true);
    expect(isGovernedPolicy('operator-choice')).toBe(false);
    expect(isGovernedPolicy(undefined)).toBe(false);
  });

  it('normalizes case and whitespace for Hardened opt-in detection', () => {
    expect(normalizeSquadCliPolicyInput(' Governed ')).toBe('governed');
    expect(isGovernedPolicy('Governed')).toBe(true);
    expect(isGovernedPolicy(' GOVERNED ')).toBe(true);
    expect(isOperatorChoicePolicy(' GOVERNED ')).toBe(false);
    // Unknown after normalize stays Autopilot — never silent Hardened.
    expect(isGovernedPolicy('hardended')).toBe(false);
    expect(isOperatorChoicePolicy('hardended')).toBe(true);
  });

  it('labels both modes in Portuguese for the UI', () => {
    expect(squadCliPolicyLabel('governed')).toContain('Hardened');
    expect(squadCliPolicyLabel('governed')).toContain('opt-in');
    expect(squadCliPolicyLabel('operator-choice')).toContain('Autopiloto');
    expect(squadCliPolicyLabel('operator-choice')).toContain('acesso de rede');
  });
});
