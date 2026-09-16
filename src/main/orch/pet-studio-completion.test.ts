import {
  mkdirSync,
  mkdtempSync,
  linkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { testProjectScope } from './__tests__/scope-fixture';
import type { ScopedMission } from './mission-store';
import {
  completePetStudioHandoff,
  reconcileCompletedPetStudioMissions,
} from './pet-studio-completion';
import { MissionLeadershipError } from './mission-leadership';

const engineMocks = vi.hoisted(() => ({
  completeVerified: vi.fn(),
}));

vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({
    completeVerified: engineMocks.completeVerified,
  }),
}));

// Onda 1 (religação da liderança): completePetStudioHandoff compara
// handoff.sessionId contra o par PROVADO por resolveMissionLeader, não mais
// contra mission.orchestratorSessionId cru. O default abaixo replica o
// comportamento anterior (líder provado == a sessão durável da fixture) sem
// exigir `resolveMissionLeader` em cada um dos 14 sítios de chamada; testes
// específicos de religação sobrescrevem via `leadershipMocks`.
const leadershipMocks = vi.hoisted(() => ({
  resolveMissionLeader: vi.fn(),
}));

vi.mock('./mission-leadership-runtime', () => ({
  getMissionLeadership: () => ({ resolveMissionLeader: leadershipMocks.resolveMissionLeader }),
}));

const scope = testProjectScope();
let sandbox = '';
let codexHome = '';
let workspaceRoot = '';
let sourcePackageDir = '';
let installedPackageDir = '';
let mission: ScopedMission;
let setStatus: ReturnType<
  typeof vi.fn<(id: string, status: ScopedMission['status']) => ScopedMission>
>;
let markSubmitted: ReturnType<typeof vi.fn<(id: string) => boolean>>;
let markConsumed: ReturnType<
  typeof vi.fn<(id: string, missionId: string) => boolean>
>;

function stores() {
  return {
    missions: {
      get: vi.fn((id: string) => (id === mission.id ? mission : null)),
      setStatus,
    },
    handoffs: { markSubmitted, markConsumed },
  };
}

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'handoff-pet',
    missionId: mission.id,
    sessionId: mission.orchestratorSessionId,
    fromAgent: 'Pet Maker',
    authorityOrigin: 'agent',
    mcpProvenance: {
      receiptId: 'receipt-pet',
      toolCallId: 'tool-pet',
      toolName: 'nexus_handoff_submit',
      source: 'http-mcp',
      missionId: mission.id,
      sessionId: mission.orchestratorSessionId!,
      authoritySha256: 'a'.repeat(64),
      issuedAt: Date.now(),
    },
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'Pet final gerado, validado e empacotado com sucesso.',
    artifacts: [
      join(sourcePackageDir, 'spritesheet.webp'),
      { path: join(sourcePackageDir, 'pet.json') },
    ],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: false,
    deliveryState: 'queued',
    createdAt: Date.now(),
    ...overrides,
  };
}

function writeValidPackage(
  target = sourcePackageDir,
  id = 'navi',
): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'spritesheet.webp'), validWebpHeader());
  writeFileSync(
    join(target, 'pet.json'),
    JSON.stringify({
      id,
      displayName: id === 'navi' ? 'Navi' : id,
      description: 'Founder-builder pet',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
    }),
  );
}

function validWebpHeader(
  width = 1_536,
  height = 2_288,
): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'nexus-pet-completion-'));
  codexHome = join(sandbox, '.codex');
  workspaceRoot = join(sandbox, 'workspace');
  installedPackageDir = join(codexHome, 'pets', 'navi');
  sourcePackageDir = join(
    workspaceRoot,
    'artifacts',
    'nexus-pet-studio',
    'mission-pet',
    'navi',
  );
  mkdirSync(workspaceRoot, { recursive: true });
  mission = {
    id: 'mission-pet',
    title: 'Create Navi',
    description: '',
    status: 'running',
    squadId: PET_STUDIO_SQUAD_ID,
    milestones: [],
    learnings: '',
    orchestratorSessionId: 'pet-session',
    createdAt: Date.now() - 100,
    updatedAt: Date.now() - 100,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
  };
  engineMocks.completeVerified.mockReset();
  engineMocks.completeVerified.mockImplementation(
    (
      _scope: unknown,
      input: {
        result: NonNullable<ScopedMission['result']>;
        learnings: string;
      },
    ) => {
      mission = {
        ...mission,
        status: 'done',
        intentState: 'done',
        result: input.result,
        learnings: input.learnings,
      };
    },
  );
  // Vitest 5: impl arrow sem params vira Mock<Procedure|Constructable> e não
  // é atribuível ao setter; params explícitos restauram a inferência.
  setStatus = vi.fn((_id: string, _status: ScopedMission['status']) => ({
    ...mission,
    status: 'done' as const,
  }));
  markSubmitted = vi.fn((_id: string) => true);
  markConsumed = vi.fn((_id: string, _missionId: string) => true);
  leadershipMocks.resolveMissionLeader.mockReset();
  leadershipMocks.resolveMissionLeader.mockImplementation(() =>
    mission.orchestratorSessionId
      ? { sessionId: mission.orchestratorSessionId, paneId: 'pane-pet', source: 'durable', proven: true }
      : null,
  );
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe('Pet Studio completion boundary', () => {
  it('installs a fresh descriptor-validated workspace package before completing', () => {
    writeValidPackage();
    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toEqual({
      handled: true,
      completed: true,
      packageDir: realpathSync(installedPackageDir),
    });
    expect(
      realpathSync(join(installedPackageDir, 'spritesheet.webp')),
    ).toBe(join(realpathSync(installedPackageDir), 'spritesheet.webp'));
    expect(engineMocks.completeVerified).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        missionId: mission.id,
        expectedStatus: 'running',
        result: {
          outcome: 'success',
          summary: 'Pet final gerado, validado e empacotado com sucesso.',
          evidenceIds: [],
          artifactRefs: [realpathSync(installedPackageDir)],
        },
      }),
    );
    expect(setStatus).not.toHaveBeenCalled();
    expect(markSubmitted).toHaveBeenCalledWith('handoff-pet');
    expect(markConsumed).toHaveBeenCalledWith('handoff-pet', mission.id);
  });

  it('keeps the mission running when the package is missing or malformed', () => {
    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({ handled: true, completed: false });
    expect(result?.error).toMatch(/não existe|ausente|validar/i);
    expect(setStatus).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  it('rejects a stale package from before this mission', () => {
    writeValidPackage();
    mission.createdAt = Date.now();
    const stale = new Date(mission.createdAt - 5_000);
    utimesSync(join(sourcePackageDir, 'spritesheet.webp'), stale, stale);
    utimesSync(join(sourcePackageDir, 'pet.json'), stale, stale);

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/anterior/),
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rejects handoffs from any session other than the bound Pet Maker', () => {
    writeValidPackage();
    const result = completePetStudioHandoff(
      handoff({ sessionId: 'foreign-session' }),
      scope,
      { codexHome, workspaceRoot, getStores: stores },
    );

    expect(result).toMatchObject({ handled: true, completed: false });
    expect(result?.error).toMatch(/sessão Pet Maker/);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('religação onda 1: A morto (source live, proven:false) recusa mesmo com sessionId igual ao durável', () => {
    writeValidPackage();
    leadershipMocks.resolveMissionLeader.mockReturnValue({
      sessionId: mission.orchestratorSessionId, paneId: 'pane-pet', source: 'live', proven: false,
    });
    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome, workspaceRoot, getStores: stores,
    });

    expect(result).toMatchObject({ handled: true, completed: false });
    expect(result?.error).toMatch(/sessão Pet Maker/);
    expect(setStatus).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  it('religação onda 1: split-brain nunca é engolido — recusa a entrega com o código, sem escolher sessão por ordem de array', () => {
    writeValidPackage();
    leadershipMocks.resolveMissionLeader.mockImplementation(() => {
      throw new MissionLeadershipError('split_brain', {
        missionId: mission.id, sessionIds: ['pet-session', 'pet-session-2'],
      });
    });
    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome, workspaceRoot, getStores: stores,
    });

    expect(result).toEqual({
      handled: true,
      completed: false,
      error: 'liderança da missão em conflito (split_brain) — entrega recusada até reconciliar',
    });
    expect(setStatus).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  it('rejects legacy terminal markers without physical MCP provenance', () => {
    writeValidPackage();
    const result = completePetStudioHandoff(
      handoff({ mcpProvenance: undefined }),
      scope,
      { codexHome, workspaceRoot, getStores: stores },
    );

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/provenance física/i),
    });
    expect(setStatus).not.toHaveBeenCalled();
    expect(() => realpathSync(installedPackageDir)).toThrow();
  });

  it('does not alter the completion rules for any normal squad', () => {
    mission.squadId = 'software-development';
    expect(
      completePetStudioHandoff(handoff(), scope, {
        codexHome,
        workspaceRoot,
        getStores: stores,
      }),
    ).toBeNull();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('recovers one finished package after restart without reopening a maker', () => {
    writeValidPackage();
    const result = reconcileCompletedPetStudioMissions(
      {
        scope,
        missions: {
          get: vi.fn((id: string) => (id === mission.id ? mission : null)),
          list: vi.fn(() => [mission]),
        },
      },
      { codexHome, workspaceRoot },
    );

    expect(result).toEqual([
      {
        missionId: mission.id,
        completed: true,
        packageDir: realpathSync(installedPackageDir),
      },
    ]);
    expect(engineMocks.completeVerified).toHaveBeenCalledOnce();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('does not recover when two fresh packages make ownership ambiguous', () => {
    writeValidPackage();
    const secondDir = join(
      workspaceRoot,
      'artifacts',
      'nexus-pet-studio',
      mission.id,
      'second',
    );
    writeValidPackage(secondDir, 'second');

    const result = reconcileCompletedPetStudioMissions(
      {
        scope,
        missions: {
          get: vi.fn((id: string) => (id === mission.id ? mission : null)),
          list: vi.fn(() => [mission]),
        },
      },
      { codexHome, workspaceRoot },
    );

    expect(result).toMatchObject([
      {
        missionId: mission.id,
        completed: false,
        error: expect.stringMatching(/ambígua/),
      },
    ]);
    expect(setStatus).not.toHaveBeenCalled();
    expect(() => realpathSync(join(codexHome, 'pets'))).toThrow();
  });

  it('rejects artifacts outside the authorized workspace', () => {
    const external = join(sandbox, 'outside', 'navi');
    writeValidPackage(external);
    mkdirSync(
      join(
        workspaceRoot,
        'artifacts',
        'nexus-pet-studio',
        mission.id,
      ),
      { recursive: true },
    );
    sourcePackageDir = external;

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/workspace autorizado/i),
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rejects symlinked source bytes instead of following them', () => {
    const external = join(sandbox, 'outside.webp');
    mkdirSync(sourcePackageDir, { recursive: true });
    writeFileSync(external, validWebpHeader());
    symlinkSync(external, join(sourcePackageDir, 'spritesheet.webp'));
    writeFileSync(
      join(sourcePackageDir, 'pet.json'),
      JSON.stringify({
        id: 'navi',
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.webp',
      }),
    );

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/workspace autorizado|symlink|ELOOP/i),
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rejects a WebP that does not implement the exact 8×11 v2 sheet', () => {
    writeValidPackage();
    writeFileSync(
      join(sourcePackageDir, 'spritesheet.webp'),
      validWebpHeader(1_536, 1_872),
    );

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/1536×2288.*8×11/i),
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rejects a package directory symlink even when it targets another direct child', () => {
    const missionOutput = join(
      workspaceRoot,
      'artifacts',
      'nexus-pet-studio',
      mission.id,
    );
    const actualPackage = join(missionOutput, 'actual');
    const linkedPackage = join(missionOutput, 'linked');
    writeValidPackage(actualPackage, 'actual');
    symlinkSync(actualPackage, linkedPackage);
    sourcePackageDir = linkedPackage;

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/canônicos|symlink/i),
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rejects multiply-linked source bytes before installation', () => {
    writeValidPackage();
    linkSync(
      join(sourcePackageDir, 'spritesheet.webp'),
      join(sandbox, 'second-hardlink.webp'),
    );

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({ handled: true, completed: false });
    expect(setStatus).not.toHaveBeenCalled();
    expect(() => realpathSync(installedPackageDir)).toThrow();
  });

  it('treats an identical installed package as an idempotent retry', () => {
    writeValidPackage();
    writeValidPackage(installedPackageDir);

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: true,
      packageDir: realpathSync(installedPackageDir),
    });
    expect(engineMocks.completeVerified).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ missionId: mission.id }),
    );
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rejects an existing pet catalog entry that is a symlink', () => {
    writeValidPackage();
    const externalInstalled = join(codexHome, 'external-navi');
    writeValidPackage(externalInstalled);
    mkdirSync(join(codexHome, 'pets'), { recursive: true });
    symlinkSync(externalInstalled, installedPackageDir);

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/não pode ser um symlink/i),
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('never overwrites a different installed pet with the same id', () => {
    writeValidPackage();
    writeValidPackage(installedPackageDir);
    writeFileSync(
      join(installedPackageDir, 'spritesheet.webp'),
      Buffer.from('RIFFdifferentWEBP', 'binary'),
    );

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      workspaceRoot,
      getStores: stores,
    });

    expect(result).toMatchObject({
      handled: true,
      completed: false,
      error: expect.stringMatching(/já existe um pet diferente.*id navi/i),
    });
    expect(setStatus).not.toHaveBeenCalled();
  });
});
