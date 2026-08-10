import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MissionIntentContract,
  MissionOrchestratorRuntimeSnapshot,
} from '../../shared/mission-intent';
import type { MissionPrepareRequest } from '../../shared/mission-engine-contract';
import type { Mission, Squad } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  releaseSealedAttachmentSnapshots,
  revalidateSealedAttachmentSnapshots,
  sealGovernedAttachmentPath,
  workspaceRootAuthorityFromScope,
} from '../persistence/dropped-files';
import { MainMissionEngine, type MainMissionEnginePorts } from './mission-engine';
import { createMissionEnginePreparationPorts } from './mission-engine-preparation';

interface PetPrepareRequest extends MissionPrepareRequest {
  profile: {
    kind: 'pet-studio';
    referenceImagePath: string;
  };
}

const forgedRoster: MissionPrepareRequest['roster'] = [
  {
    id: 'pet-maker',
    agentName: 'Forged maker',
    category: 'orchestrator',
    cli: 'claude',
    allowedTools: null,
    allowedSkills: null,
  },
  {
    id: 'hidden-worker',
    agentName: 'Hidden worker',
    category: 'executor',
    cli: 'codex',
    allowedTools: ['Bash'],
    allowedSkills: [],
  },
];

const runtime: MissionOrchestratorRuntimeSnapshot = {
  adapterId: 'codex',
  model: PET_STUDIO_SQUAD.agents[0]!.model,
  readOnly: false,
  nativeReadOnly: false,
};

function storeHarness() {
  let mission: Mission | null = null;
  return {
    missions: {
      create(input: {
        title: string;
        description?: string;
        squadId?: string;
        intentState?: Mission['intentState'];
        intentContract?: MissionIntentContract;
        intentVersion?: number;
      }): Mission {
        mission = {
          id: 'mission-pet',
          title: input.title,
          description: input.description ?? '',
          status: 'pending',
          squadId: input.squadId,
          milestones: [],
          learnings: '',
          intentState: input.intentState,
          intentContract: input.intentContract,
          intentVersion: input.intentVersion ?? 0,
          createdAt: 100,
          updatedAt: 100,
        };
        return mission;
      },
      get(missionId: string): Mission | null {
        return mission?.id === missionId ? mission : null;
      },
      bindMissionRuntimeSquad(
        missionId: string,
        expected: Mission,
        squadId: string,
        contract?: MissionIntentContract,
      ): Mission {
        if (!mission || mission.id !== missionId || mission !== expected) {
          throw new Error('mission preparation CAS changed');
        }
        mission = {
          ...mission,
          squadId,
          intentContract: contract ?? mission.intentContract,
          updatedAt: mission.updatedAt + 1,
        };
        return mission;
      },
      removeIfUnchanged(missionId: string, expected: Readonly<Mission>) {
        if (!mission || mission.id !== missionId) return 'missing' as const;
        if (mission !== expected) return 'changed' as const;
        mission = null;
        return 'removed' as const;
      },
    },
    current: () => mission,
  };
}

function request(referenceImagePath: string): PetPrepareRequest {
  return {
    title: 'Criar pet cat-source',
    objective: 'Criar um pet Nexus completo a partir desta imagem.',
    contextPaths: [],
    roster: forgedRoster,
    advanced: { lane: 'standard' },
    profile: { kind: 'pet-studio', referenceImagePath },
  };
}

function engineHarness(rootRealPath: string, sealedHomeDir: string) {
  const canonicalRoot = fs.realpathSync(rootRealPath);
  const rootStat = fs.lstatSync(canonicalRoot, { bigint: true });
  const scope: ProjectExecutionScope = {
    version: 1,
    installationId: 'installation-pet',
    projectId: 'project-pet',
    checkoutId: 'checkout-pet',
    rootRealPath: canonicalRoot,
    workspaceRootDevice: rootStat.dev.toString(),
    workspaceRootInode: rootStat.ino.toString(),
    identitySource: 'manifest',
  };
  const store = storeHarness();
  const persistRuntimeSquad = vi.fn((_request: MissionPrepareRequest): Squad =>
    structuredClone(PET_STUDIO_SQUAD),
  );
  const preparation = createMissionEnginePreparationPorts({
    scope,
    missions: store.missions,
    deps: {
      now: () => 200,
      persistRuntimeSquad,
      getSquad: (id) =>
        id === PET_STUDIO_SQUAD.id ? structuredClone(PET_STUDIO_SQUAD) : null,
      resolveRuntime: () => runtime,
      discardRuntimeSquad: () => true,
      sealPetStudioImage: (trustedScope, sourcePath) =>
        sealGovernedAttachmentPath(sourcePath, {
          workspaceRootAuthority: workspaceRootAuthorityFromScope(trustedScope),
          checkoutId: trustedScope.checkoutId,
          homeDir: sealedHomeDir,
        }),
      releasePetStudioAttachments: (trustedScope, snapshots) =>
        releaseSealedAttachmentSnapshots(snapshots, {
          checkoutId: trustedScope.checkoutId,
          homeDir: sealedHomeDir,
        }),
    },
  });
  const seal = vi.fn(async () => undefined);
  const bootstrap = vi.fn(async () => undefined);
  const ports: MainMissionEnginePorts = {
    ...preparation,
    readReviewFence: async (missionId) => {
      const reviewSha256 = store.current()?.intentContract?.approvalReviewSha256;
      return reviewSha256 ? { missionId, reviewSha256 } : null;
    },
    revalidatePetStudioAttachments: (snapshots) =>
      revalidateSealedAttachmentSnapshots(snapshots, {
        workspaceRootAuthority: workspaceRootAuthorityFromScope(scope),
        checkoutId: scope.checkoutId,
        homeDir: sealedHomeDir,
      }),
    seal,
    bootstrap,
    retryKickoff: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
    direct: async () => undefined,
    answerQuestion: async () => undefined,
    blockUser: () => undefined,
    blockTechnical: () => undefined,
    resumeTechnical: () => undefined,
    completeVerified: () => undefined,
    readSnapshotView: async (missionId) => ({
      mission: {
        id: missionId,
        title: 'Criar pet cat-source',
        objective: 'Criar um pet Nexus completo a partir desta imagem.',
        workspaceLabel: 'workspace',
        status: 'pending',
        version: 1,
        updatedAt: store.current()?.updatedAt ?? 100,
      },
      hasDispatchAuthority: true,
      hasCurrentKickoffReceipt: true,
      orchestratorLive: true,
      tasks: [],
      handoffs: [],
      panes: [],
      roster: PET_STUDIO_SQUAD.agents,
    }),
    listSnapshotViews: async () => [],
  };
  return {
    scope,
    store,
    persistRuntimeSquad,
    seal,
    bootstrap,
    preparation,
    engine: new MainMissionEngine(scope, ports),
  };
}

let tempRoot = '';
let workspaceRoot = '';
let sealedHomeDir = '';
let attachmentsRoot = '';
let imagePath = '';

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pet-profile-'));
  workspaceRoot = path.join(tempRoot, 'workspace');
  sealedHomeDir = path.join(tempRoot, 'home');
  fs.mkdirSync(workspaceRoot, { mode: 0o700 });
  fs.mkdirSync(sealedHomeDir, { mode: 0o700 });
  attachmentsRoot = path.join(workspaceRoot, '.nexus', 'attachments');
  fs.mkdirSync(attachmentsRoot, { recursive: true, mode: 0o700 });
  imagePath = path.join(attachmentsRoot, 'cat-source.png');
  fs.writeFileSync(imagePath, Buffer.from('approved-pet-image'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('main-owned Pet Studio preparation', () => {
  it('ignores a renderer-forged roster and seals the exact single Codex maker plus image bytes', async () => {
    const value = engineHarness(workspaceRoot, sealedHomeDir);

    const review = await value.engine.prepare(value.scope, request(imagePath));

    const canonicalImagePath = fs.realpathSync(imagePath);
    const snapshot = review.attachments![0]!;
    expect(snapshot.sourcePath).toBe(canonicalImagePath);
    expect(snapshot.path).not.toBe(canonicalImagePath);
    expect(snapshot.path).toContain(
      `${path.join(fs.realpathSync(sealedHomeDir), '.nexus', 'mission-attachments', 'checkout-pet')}${path.sep}`,
    );
    expect(snapshot.sealId).toMatch(/^[a-f0-9]{32}$/);
    expect(snapshot.device).toMatch(/^[0-9]+$/);
    expect(snapshot.inode).toMatch(/^[0-9]+$/);
    expect(fs.readFileSync(snapshot.path)).toEqual(
      fs.readFileSync(canonicalImagePath),
    );
    expect(review.roster).toEqual(PET_STUDIO_SQUAD.agents);
    expect(review.attachments).toEqual([snapshot]);
    expect(value.persistRuntimeSquad).toHaveBeenCalledWith(
      expect.objectContaining({
        roster: PET_STUDIO_SQUAD.agents,
        profile: {
          kind: 'pet-studio',
          referenceImagePath: snapshot.path,
        },
      }),
    );
    expect(value.store.current()).toMatchObject({
      intentContract: {
        attachmentPaths: [snapshot.path],
        attachmentSnapshots: [snapshot],
        budgets: { maxWorkers: 0 },
        deniedTools: expect.arrayContaining([
          'route_task',
          'pane_spawn',
          'task',
          'worktree_create',
        ]),
      },
    });
  });

  it('covers the governed image snapshot with the exact review fence', async () => {
    const first = engineHarness(workspaceRoot, sealedHomeDir);
    const firstReview = await first.engine.prepare(first.scope, request(imagePath));

    fs.writeFileSync(imagePath, Buffer.from('different-pet-image'));
    const second = engineHarness(workspaceRoot, sealedHomeDir);
    const secondReview = await second.engine.prepare(
      second.scope,
      request(imagePath),
    );

    expect(firstReview.attachments![0]?.sha256).not.toBe(
      secondReview.attachments![0]?.sha256,
    );
    expect(firstReview.reviewSha256).not.toBe(secondReview.reviewSha256);
  });

  it.each([
    ['outside the governed root', () => {
      const outside = path.join(tempRoot, 'outside.png');
      fs.writeFileSync(outside, 'outside');
      return outside;
    }],
    ['a symlink under the governed root', () => {
      const outside = path.join(tempRoot, 'outside.png');
      fs.writeFileSync(outside, 'outside');
      const link = path.join(attachmentsRoot, 'linked.png');
      fs.symlinkSync(outside, link);
      return link;
    }],
    ['a multiply linked file', () => {
      const linked = path.join(attachmentsRoot, 'linked-again.png');
      fs.linkSync(imagePath, linked);
      return imagePath;
    }],
  ])('rejects %s before persisting mission authority', async (_case, candidate) => {
    const value = engineHarness(workspaceRoot, sealedHomeDir);

    await expect(
      value.engine.prepare(value.scope, request(candidate())),
    ).rejects.toThrow();
    expect(value.persistRuntimeSquad).not.toHaveBeenCalled();
    expect(value.store.current()).toBeNull();
  });

  it('rejects a reference image owned by a different uid', async () => {
    if (typeof process.getuid !== 'function') return;
    const actualUid = process.getuid();
    vi.spyOn(
      process as NodeJS.Process & { getuid(): number },
      'getuid',
    ).mockReturnValue(actualUid + 1);
    const value = engineHarness(workspaceRoot, sealedHomeDir);

    await expect(
      value.engine.prepare(value.scope, request(imagePath)),
    ).rejects.toThrow(/owner|uid/i);
    expect(value.persistRuntimeSquad).not.toHaveBeenCalled();
  });

  it('starts from the sealed artifact after the display source mutates', async () => {
    const value = engineHarness(workspaceRoot, sealedHomeDir);
    const review = await value.engine.prepare(value.scope, request(imagePath));
    const sealedPath = review.attachments![0]!.path;
    const sealedBytes = fs.readFileSync(sealedPath);
    fs.writeFileSync(imagePath, Buffer.from('changed-after-review'));

    await value.engine.start(value.scope, {
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });

    expect(fs.readFileSync(sealedPath)).toEqual(sealedBytes);
    expect(value.seal).toHaveBeenCalledOnce();
    expect(value.bootstrap).toHaveBeenCalledOnce();
  });

  it('fails before start when the sealed artifact hash drifts', async () => {
    const value = engineHarness(workspaceRoot, sealedHomeDir);
    const review = await value.engine.prepare(value.scope, request(imagePath));
    const sealedPath = review.attachments![0]!.path;
    fs.chmodSync(sealedPath, 0o600);
    fs.writeFileSync(
      sealedPath,
      Buffer.alloc(review.attachments![0]!.size, 0x78),
    );
    fs.chmodSync(sealedPath, 0o400);

    await expect(
      value.engine.start(value.scope, {
        missionId: review.missionId,
        reviewSha256: review.reviewSha256,
      }),
    ).rejects.toThrow(/attachment|hash|snapshot|changed/i);
    expect(value.seal).not.toHaveBeenCalled();
    expect(value.bootstrap).not.toHaveBeenCalled();
  });

  it('retains the exact sealed artifact when bootstrap fails for retry', async () => {
    const value = engineHarness(workspaceRoot, sealedHomeDir);
    const review = await value.engine.prepare(value.scope, request(imagePath));
    const sealedPath = review.attachments![0]!.path;
    value.bootstrap.mockRejectedValueOnce(new Error('spawn failed'));

    await expect(
      value.engine.start(value.scope, {
        missionId: review.missionId,
        reviewSha256: review.reviewSha256,
      }),
    ).rejects.toThrow(/spawn failed/i);
    expect(fs.existsSync(sealedPath)).toBe(true);
  });

  it('releases the seal only after exact unfenced cancellation removes the mission', async () => {
    const value = engineHarness(workspaceRoot, sealedHomeDir);
    const armed = await value.preparation.arm(request(imagePath));
    const sealedPath =
      value.store.current()!.intentContract!.attachmentSnapshots![0]!.path;

    expect(
      await value.preparation.discardUnfencedPreparation(armed),
    ).toBe(true);
    expect(fs.existsSync(sealedPath)).toBe(false);
    expect(fs.existsSync(imagePath)).toBe(true);
  });
});
