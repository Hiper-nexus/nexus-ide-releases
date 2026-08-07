import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import {
  isOperatorSubmit,
  operatorSubmitUnparkPatch,
} from './mission-operator-reply';

function mission(patch: Partial<Mission>): Pick<Mission, 'status' | 'intentState'> {
  return {
    status: 'blocked',
    intentState: 'blocked_user',
    ...patch,
  } as Pick<Mission, 'status' | 'intentState'>;
}

describe('isOperatorSubmit', () => {
  it('fires on the submitted line, not on every keystroke', () => {
    expect(isOperatorSubmit('a')).toBe(false);
    expect(isOperatorSubmit('pode seguir')).toBe(false);
    expect(isOperatorSubmit('\r')).toBe(true);
    expect(isOperatorSubmit('pode seguir\n')).toBe(true);
  });
});

describe('operatorSubmitUnparkPatch', () => {
  it('does not let raw pane input bypass durable clarify consumption', () => {
    expect(operatorSubmitUnparkPatch(mission({}))).toBeNull();
  });

  it('leaves a technical block to its own recovery', () => {
    // Typing must not resurrect a mission Nexus blocked for a real failure.
    expect(
      operatorSubmitUnparkPatch(mission({ intentState: 'blocked_technical' })),
    ).toBeNull();
  });

  it('does nothing for a mission that is not parked', () => {
    expect(
      operatorSubmitUnparkPatch(
        mission({ status: 'running', intentState: 'executing' }),
      ),
    ).toBeNull();
    expect(
      operatorSubmitUnparkPatch(mission({ status: 'done', intentState: 'done' })),
    ).toBeNull();
    expect(
      operatorSubmitUnparkPatch(mission({ status: 'pending', intentState: 'draft' })),
    ).toBeNull();
  });
});
