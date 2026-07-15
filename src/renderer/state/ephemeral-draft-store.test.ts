import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearEphemeralDraft,
  peekEphemeralDraft,
  saveEphemeralDraft,
  useEphemeralDraftStore,
} from './ephemeral-draft-store';

describe('ephemeral-draft-store', () => {
  beforeEach(() => {
    useEphemeralDraftStore.getState().clearAll();
  });

  it('saves and peeks drafts without clearing', () => {
    saveEphemeralDraft('voice-settings', { assistantName: 'Jarvis', dirty: true });
    expect(peekEphemeralDraft<{ assistantName: string }>('voice-settings')).toEqual({
      assistantName: 'Jarvis',
      dirty: true,
    });
    expect(peekEphemeralDraft('voice-settings')).toBeDefined();
  });

  it('clears one key without touching others', () => {
    saveEphemeralDraft('voice-settings', { a: 1 });
    saveEphemeralDraft('diff-annotate', { notes: 2 });
    clearEphemeralDraft('voice-settings');
    expect(peekEphemeralDraft('voice-settings')).toBeUndefined();
    expect(peekEphemeralDraft('diff-annotate')).toEqual({ notes: 2 });
  });

  it('clearAll wipes the pocket', () => {
    saveEphemeralDraft('agent-picker', { id: 'claude' });
    useEphemeralDraftStore.getState().clearAll();
    expect(peekEphemeralDraft('agent-picker')).toBeUndefined();
  });
});
