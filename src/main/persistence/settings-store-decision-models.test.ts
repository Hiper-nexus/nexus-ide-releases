import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), on: () => {} },
  app: { getPath: () => '/nonexistent-nexus-test-home' },
}));
vi.mock('./atomic-json-file', () => ({ writeJsonFileAtomic: vi.fn() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = (file: unknown, ...rest: unknown[]) => {
    if (String(file).endsWith('settings.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  };
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

import { bindTrustedMainWindow } from '../security/trusted-ipc';
import { SETTINGS_CHANNELS } from '../../shared/settings-types';
import { decisionCredentialRevision } from '../decision-models/decision-revision';
import { hasVisionRecipientConsent } from '../../shared/decision-models';
import { getOrchSettings, registerSettingsIpc, replaceOrchSettings } from './settings-store';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
function trustedEvent() {
  const sender = { getURL: () => 'nexus-app://bundle/index.html', isDestroyed: () => false,
    isCrashed: () => false, once: () => {}, mainFrame: {} };
  bindTrustedMainWindow({ webContents: sender, isDestroyed: () => false } as any, 'nexus-app://bundle/index.html');
  return { sender, senderFrame: sender.mainFrame };
}

describe('decision configuration revision (in-flight and cache authority)', () => {
  beforeEach(() => { handlers.clear(); registerSettingsIpc(); replaceOrchSettings({ decisionModels: { mode: 'jev', clefModel: 'clef', cloudflareAccountId: '', visionEnabled: false } }); });

  it('bumps when the main process replaces the decision models', () => {
    const before = decisionCredentialRevision();
    replaceOrchSettings({ decisionModels: { mode: 'auto', clefModel: 'clef', cloudflareAccountId: ACCOUNT, visionEnabled: false } });
    expect(decisionCredentialRevision()).toBe(before + 1);
    expect(getOrchSettings().decisionModels.mode).toBe('auto');
  });

  it('does not bump for an unrelated orchestration setting or an identical decision model value', () => {
    const before = decisionCredentialRevision();
    replaceOrchSettings({ leanCode: !getOrchSettings().leanCode });
    replaceOrchSettings({ decisionModels: { ...getOrchSettings().decisionModels } });
    expect(decisionCredentialRevision()).toBe(before);
  });

  it('bumps through the trusted orchSet IPC, and only when the decision models changed', () => {
    const orchSet = handlers.get(SETTINGS_CHANNELS.orchSet)!;
    const before = decisionCredentialRevision();
    orchSet(trustedEvent(), { decisionModels: { mode: 'clef', clefModel: 'clef-flash', cloudflareAccountId: ACCOUNT, visionEnabled: false } });
    expect(decisionCredentialRevision()).toBe(before + 1);
    orchSet(trustedEvent(), { leanCode: !getOrchSettings().leanCode });
    expect(decisionCredentialRevision()).toBe(before + 1);
  });

  it('persists no image consent once image analysis is off, and Somente Jev never widens a legacy one', () => {
    const orchSet = handlers.get(SETTINGS_CHANNELS.orchSet)!;
    orchSet(trustedEvent(), { decisionModels: { mode: 'auto', clefModel: 'clef', cloudflareAccountId: ACCOUNT, visionEnabled: true } });
    expect(getOrchSettings().decisionModels.visionEnabled).toBe(true);
    orchSet(trustedEvent(), { decisionModels: { ...getOrchSettings().decisionModels, mode: 'jev' } });
    expect(getOrchSettings().decisionModels.visionEnabled).toBe(true);
    expect(hasVisionRecipientConsent(getOrchSettings().decisionModels, 'clef')).toBe(false);
    orchSet(trustedEvent(), { decisionModels: { ...getOrchSettings().decisionModels, visionEnabled: false } });
    expect(getOrchSettings().decisionModels.visionEnabled).toBe(false);
    orchSet(trustedEvent(), { decisionModels: { ...getOrchSettings().decisionModels, mode: 'auto' } });
    expect(getOrchSettings().decisionModels.visionEnabled).toBe(false);
  });

  it('persists clef-omni with its audio consent and keeps it out of any other variant', () => {
    const orchSet = handlers.get(SETTINGS_CHANNELS.orchSet)!;
    orchSet(trustedEvent(), { decisionModels: { mode: 'clef', clefModel: 'clef-omni', cloudflareAccountId: ACCOUNT, visionEnabled: false,
      audioConsent: { version: 1, recipients: ['clef'] } } });
    expect(getOrchSettings().decisionModels).toMatchObject({ clefModel: 'clef-omni', audioConsent: { version: 1, recipients: ['clef'] } });
    orchSet(trustedEvent(), { decisionModels: { ...getOrchSettings().decisionModels, clefModel: 'clef-flash' } });
    expect(getOrchSettings().decisionModels).toMatchObject({ clefModel: 'clef-flash', audioConsent: { version: 1, recipients: [] } });
  });
});

describe('F-1167: jevSurfaces parcial é mesclado no Main (sem corrida entre telas)', () => {
  beforeEach(() => { handlers.clear(); registerSettingsIpc(); });

  it('orchSet com só as quatro fases preserva as outras superfícies; patch completo continua valendo', () => {
    const orchSet = handlers.get(SETTINGS_CHANNELS.orchSet)!;
    orchSet(trustedEvent(), { jevSurfaces: { ...getOrchSettings().jevSurfaces, paneState: false, intake: false } });
    orchSet(trustedEvent(), { jevSurfaces: { missionKickoff: false, reviewTriage: false, recoveryAdvice: false, completionCheck: false } });
    expect(getOrchSettings().jevSurfaces).toMatchObject({ paneState: false, intake: false, handoffReview: true,
      missionKickoff: false, reviewTriage: false, recoveryAdvice: false, completionCheck: false });
    // A outra tela grava uma chave só: as fases desligadas acima ficam como estão.
    orchSet(trustedEvent(), { jevSurfaces: { paneState: true } });
    expect(getOrchSettings().jevSurfaces).toMatchObject({ paneState: true, intake: false, missionKickoff: false });
    replaceOrchSettings({ jevSurfaces: { missionKickoff: true } } as never);
    expect(getOrchSettings().jevSurfaces).toMatchObject({ missionKickoff: true, reviewTriage: false, intake: false });
  });

  it('valor inválido numa chave parcial é recusado sem mudar nada', () => {
    const orchSet = handlers.get(SETTINGS_CHANNELS.orchSet)!;
    const before = JSON.stringify(getOrchSettings().jevSurfaces);
    orchSet(trustedEvent(), { jevSurfaces: { missionKickoff: 'sim' } });
    expect(JSON.stringify(getOrchSettings().jevSurfaces)).toBe(before);
  });
});
