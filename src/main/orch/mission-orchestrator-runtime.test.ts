import { describe, expect, it } from 'vitest';
import {
  assertMissionOrchestratorEvidence,
  canonicalMissionOrchestratorRuntime,
  preferredMissionOrchestratorAdapterId,
  sameMissionOrchestratorRuntime,
} from './mission-orchestrator-runtime';

describe('mission orchestrator runtime authority', () => {
  it('canonicalizes every approved runtime field without renderer defaults', () => {
    expect(
      canonicalMissionOrchestratorRuntime({
        adapterId: ' codex ',
        model: ' gpt-5.6-sol ',
        accountId: ' account-a ',
        effort: ' high ',
        readOnly: false,
        nativeReadOnly: true,
      }),
    ).toEqual({
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-a',
      effort: 'high',
      readOnly: false,
      nativeReadOnly: true,
    });
  });

  it('rejects either an MCP read-only orchestrator or missing native confinement', () => {
    expect(() =>
      canonicalMissionOrchestratorRuntime({
        adapterId: 'codex',
        readOnly: true,
        nativeReadOnly: true,
      }),
    ).toThrow(/Nexus MCP delegável/i);
    expect(() =>
      canonicalMissionOrchestratorRuntime({
        adapterId: 'codex',
        readOnly: false,
        nativeReadOnly: false,
      }),
    ).toThrow(/confinamento nativo read-only/i);
  });

  it('uses exact optional-field equality and roster-first adapter selection', () => {
    const approved = canonicalMissionOrchestratorRuntime({
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-a',
      effort: 'high',
      readOnly: false,
      nativeReadOnly: true,
    });
    expect(
      sameMissionOrchestratorRuntime(approved, {
        ...approved,
        accountId: 'account-b',
      }),
    ).toBe(false);
    expect(
      preferredMissionOrchestratorAdapterId({ cli: 'codex' }, 'claude'),
    ).toBe('codex');
  });

  it('permite experimental apenas no roster salvo e bloqueia promoção automática', () => {
    expect(() =>
      assertMissionOrchestratorEvidence({
        evidence: 'experimental',
        selection: 'saved-roster',
        label: 'Kimi',
      }),
    ).not.toThrow();
    expect(() =>
      assertMissionOrchestratorEvidence({
        evidence: 'experimental',
        selection: 'automatic',
        label: 'Kimi',
      }),
    ).toThrow(/experimental.*promovido automaticamente.*verificado/i);
    expect(() =>
      assertMissionOrchestratorEvidence({
        evidence: 'unsupported',
        selection: 'saved-roster',
        label: 'Aider',
      }),
    ).toThrow(/não tem evidência válida/i);
  });
});
