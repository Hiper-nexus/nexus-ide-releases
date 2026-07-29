import { describe, expect, it } from 'vitest';
import {
  isOperatorChoicePolicy,
  squadCliPolicyLabel,
} from './squad-cli-policy';

describe('squad-cli-policy', () => {
  it('recognizes operator-choice and rejects everything else', () => {
    expect(isOperatorChoicePolicy('operator-choice')).toBe(true);
    expect(isOperatorChoicePolicy('governed')).toBe(false);
    expect(isOperatorChoicePolicy(undefined)).toBe(false);
    expect(isOperatorChoicePolicy(null)).toBe(false);
    expect(isOperatorChoicePolicy('yolo')).toBe(false);
  });

  it('labels both modes in Portuguese for the UI', () => {
    expect(squadCliPolicyLabel('governed')).toContain('Hardened');
    expect(squadCliPolicyLabel('operator-choice')).toContain('Autopiloto');
    expect(squadCliPolicyLabel('operator-choice')).toContain('web liberada');
  });
});
