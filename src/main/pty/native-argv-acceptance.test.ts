import { afterEach, describe, expect, it } from 'vitest';
import { acceptedNativeArgvPrompt, armNativeArgvAcceptance, forgetNativeArgvAcceptance,
  recordNativeArgvSubmission, type NativeArgvIdentity } from './native-argv-acceptance';
const info: NativeArgvIdentity = { sessionId: 'fresh-sid', paneId: 'pane', adapterId: 'claude',
  accountId: 'account', model: 'model', readOnly: false, allowedTools: null, allowedSkills: null, cwd: '/private/project', source: 'pending', role: 'worker',
  missionId: 'mission', workerIncarnationId: 'incarnation',
  scope: { version: 1, installationId: 'install', projectId: 'project', checkoutId: 'checkout',
    rootRealPath: '/private/project', identitySource: 'provisional' },
  authoritySeal: { intentVersion: 1, intentContractHash: 'intent', contextRevision: 'revision',
    contractHash: 'contract', squadRevisionHash: 'squad' } };
afterEach(() => forgetNativeArgvAcceptance(info.sessionId));
describe('F-1139 private exact physical argv receipt', () => {
  it('retains only a matching first submission for the same launch and prompt', () => {
    armNativeArgvAcceptance(info, 'lease', 'actual argv');
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv')).toBe(false);
    recordNativeArgvSubmission(info, 'lease', 'actual argv');
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv')).toBe(true);
    expect(acceptedNativeArgvPrompt(info, 'lease', 'new pasted prompt')).toBe(false);
    // Stop is deliberately not an input: acceptance survives completion.
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv')).toBe(true);
    forgetNativeArgvAcceptance(info.sessionId);
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv')).toBe(false);
  });
  it.each(['wrong first prompt', undefined, null])('never lets a later correct turn replace a first mismatch (%s)', prompt => {
    armNativeArgvAcceptance(info, 'lease', 'actual argv');
    recordNativeArgvSubmission(info, 'lease', prompt);
    recordNativeArgvSubmission(info, 'lease', 'actual argv');
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv')).toBe(false);
  });
  it.each([
    { sessionId: 'replacement-sid' }, { paneId: 'replacement-pane' }, { adapterId: 'codex' },
    { accountId: 'other-account' }, { allowedTools: ['new-tool'] }, { allowedSkills: ['new-skill'] },
    { requestedModel: 'other-request' }, { effort: 'other-effort' }, { readOnly: true }, { nativeReadOnly: true },
    { operatorOpened: true as const }, { promotedFromUser: true as const }, { role: 'orchestrator' as const }, { source: 'direct-user' as const },
    { workerIncarnationId: 'other-generation' }, { missionId: 'other-mission' },
    { scope: { ...info.scope, rootRealPath: '/other' } },
    { scope: { ...info.scope, checkoutId: 'other-checkout' } },
    { scope: { ...info.scope, workspaceRootDevice: '11', workspaceRootInode: '12' } },
    { authoritySeal: { ...info.authoritySeal!, contextRevision: 'other-seal' } },
  ])('refuses identity drift %j', change => {
    armNativeArgvAcceptance(info, 'lease', 'actual argv');
    recordNativeArgvSubmission(info, 'lease', 'actual argv');
    expect(acceptedNativeArgvPrompt({ ...info, ...change }, 'lease', 'actual argv')).toBe(false);
  });
  it('refuses lease replacement at ingestion and consumption', () => {
    armNativeArgvAcceptance(info, 'lease', 'actual argv');
    recordNativeArgvSubmission(info, 'other-lease', 'actual argv');
    recordNativeArgvSubmission(info, 'lease', 'actual argv');
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv')).toBe(false);
    armNativeArgvAcceptance(info, 'lease', 'actual argv');
    recordNativeArgvSubmission(info, 'lease', 'actual argv');
    expect(acceptedNativeArgvPrompt(info, 'other-lease', 'actual argv')).toBe(false);
  });
  it('refuses a different authenticated bearer even on the same physical lease', () => {
    armNativeArgvAcceptance(info, 'lease', 'actual argv', 'original-bearer');
    recordNativeArgvSubmission(info, 'lease', 'actual argv', 'original-bearer');
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv', 'replacement-bearer')).toBe(false);
  });
  it('never creates proof for an unarmed session (paste/resume/adopt/warm)', () => {
    recordNativeArgvSubmission(info, 'lease', 'actual argv');
    expect(acceptedNativeArgvPrompt(info, 'lease', 'actual argv')).toBe(false);
  });
});
