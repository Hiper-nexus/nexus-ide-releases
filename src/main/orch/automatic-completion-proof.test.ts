import { describe, expect, it } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import { getAutomaticCompletionProof, isAutomaticCompletionProof, withAutomaticCompletionProof } from './automatic-completion-proof';

const scope = testProjectScope({ workspaceRootDevice: '1', workspaceRootInode: '10' });
const mission = { id: 'reviewed', intentVersion: 2, updatedAt: 10, intentState: 'executing' as const };

describe('automatic completion proof', () => {
  it('exposes only the current internal proof for the exact scope and mission incarnation', () => {
    const input = { status: 'verified' as const, candidateFingerprint: 'physical-candidate' };
    let captured: unknown;
    expect(withAutomaticCompletionProof(scope, mission, input, () => {
      captured = getAutomaticCompletionProof(scope, mission);
      expect(captured).toEqual(input);
      expect(isAutomaticCompletionProof(captured)).toBe(true);
      expect(isAutomaticCompletionProof(captured, scope, mission)).toBe(true);
      expect(isAutomaticCompletionProof(captured, { ...scope, checkoutId: 'other' }, mission)).toBe(false);
      expect(isAutomaticCompletionProof(captured, scope, { ...mission, intentVersion: 3 })).toBe(false);
      expect(isAutomaticCompletionProof(input)).toBe(false);
      expect(getAutomaticCompletionProof({ ...scope, checkoutId: 'other' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof({ ...scope, workspaceRootInode: '11' }, mission)).toBeNull();
      expect(getAutomaticCompletionProof(scope, { ...mission, intentVersion: 3 })).toBeNull();
      expect(getAutomaticCompletionProof(scope, { ...mission, updatedAt: 11 })).toBeNull();
      return true;
    })).toBe(true);
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
    expect(isAutomaticCompletionProof(captured)).toBe(false);
  });

  it('clears unavailable proof after an exception and never upgrades its status', () => {
    expect(() => withAutomaticCompletionProof(scope, mission, { status: 'unavailable', note: 'Sem varredura' }, () => {
      expect(getAutomaticCompletionProof(scope, mission)?.status).toBe('unavailable');
      throw new Error('completion failed');
    })).toThrow('completion failed');
    expect(getAutomaticCompletionProof(scope, mission)).toBeNull();
  });
});
