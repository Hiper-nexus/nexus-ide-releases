import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/account-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { PET_STUDIO_SQUAD } from '../../../shared/pet-studio';
import type { AdapterInfo } from '../../../shared/types';
import type { MissionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
import { missionRosterIssue } from './TeamStep';

interface PetEntryContext {
  kind: 'pet-studio';
  origin: 'settings-appearance';
  objective: string;
  title: string;
  roster: typeof PET_STUDIO_SQUAD.agents;
  profile: {
    kind: 'pet-studio';
    referenceImagePath: string;
  };
  step: 'review';
  revision: number;
}

interface PetRosterIssueInput {
  roster: typeof PET_STUDIO_SQUAD.agents;
  readiness: MissionRuntimeReadiness;
  providers: readonly ProviderSettingsInfo[];
  accounts: readonly AccountInfo[];
  entryContext: PetEntryContext | null;
}

type PetRosterIssue = (input: PetRosterIssueInput) => string | null;

const petRosterIssue = missionRosterIssue as unknown as PetRosterIssue;
const codex = {
  id: 'codex',
  kind: 'cli-pty',
  label: 'Codex',
  icon: 'X',
  models: {
    list: [PET_STUDIO_SQUAD.agents[0]!.model],
    default: PET_STUDIO_SQUAD.agents[0]!.model,
  },
  installed: true,
  installCommand: '',
  idleTimeoutMs: 1_000,
  orchestratorCapable: true,
  taskHandoffCapable: true,
  missionControlCapable: true,
  autonomousWorkspaceWriteCapable: true,
  orchestrationEvidence: 'verified',
  capabilities: {
    launchable: true,
    promptInjectable: true,
    statusObservable: true,
    resumable: true,
    autonomousReadOnly: true,
    governedWriter: true,
    verifiedMaestro: true,
  },
} as AdapterInfo;
const readiness: MissionRuntimeReadiness = {
  detectedAdapters: [codex],
  authenticatedAdapters: [codex],
  readyProviders: [codex],
  verifiedMaestros: [codex],
  qualifiedWorkers: [codex],
  hasOperationalRoute: true,
  multiProviderReady: false,
};
const providers = [
  {
    adapterId: 'codex',
    label: 'Codex',
    icon: 'X',
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: 'codex',
    defaultModel: PET_STUDIO_SQUAD.agents[0]!.model!,
    models: [PET_STUDIO_SQUAD.agents[0]!.model!],
    authReadyModels: [PET_STUDIO_SQUAD.agents[0]!.model!],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'oauth',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: 'codex',
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: 'high',
    efforts: ['high'],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
  },
] satisfies ProviderSettingsInfo[];
const context: PetEntryContext = {
  kind: 'pet-studio',
  origin: 'settings-appearance',
  objective: 'Criar o pet governado.',
  title: 'Criar pet cat-source',
  roster: PET_STUDIO_SQUAD.agents,
  profile: {
    kind: 'pet-studio',
    referenceImagePath:
      '/workspace/.nexus/attachments/pet-studio/cat-source.png',
  },
  step: 'review',
  revision: 1,
};

describe('Pet Studio single-seat isolation', () => {
  it('accepts one seat only for the active exact Pet context', () => {
    expect(
      petRosterIssue({
        roster: PET_STUDIO_SQUAD.agents,
        readiness,
        providers,
        accounts: [],
        entryContext: context,
      }),
    ).toBeNull();
  });

  it.each([
    ['ordinary setup', null, PET_STUDIO_SQUAD.agents],
    [
      'lookalike roster',
      context,
      [
        {
          ...PET_STUDIO_SQUAD.agents[0]!,
          allowedTools: [
            ...(PET_STUDIO_SQUAD.agents[0]!.allowedTools ?? []),
            'Bash',
          ],
        },
      ],
    ],
    [
      'lookalike profile',
      {
        ...context,
        profile: {
          kind: 'pet-studio' as const,
          referenceImagePath: '/tmp/ungoverned.png',
        },
      },
      PET_STUDIO_SQUAD.agents,
    ],
  ])('rejects a one-seat %s', (_case, entryContext, roster) => {
    expect(
      petRosterIssue({
        roster: roster as typeof PET_STUDIO_SQUAD.agents,
        readiness,
        providers,
        accounts: [],
        entryContext,
      }),
    ).not.toBeNull();
  });
});
