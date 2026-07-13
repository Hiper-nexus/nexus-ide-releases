import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
import { completePetStudioHandoff } from './pet-studio-completion';

const scope = testProjectScope();
let sandbox = '';
let codexHome = '';
let packageDir = '';
let mission: ScopedMission;
let setStatus: ReturnType<typeof vi.fn>;
let markSubmitted: ReturnType<typeof vi.fn>;
let markConsumed: ReturnType<typeof vi.fn>;

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
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'Pet final gerado, validado e empacotado com sucesso.',
    artifacts: [
      join(packageDir, 'spritesheet.webp'),
      { path: join(packageDir, 'pet.json') },
    ],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: false,
    deliveryState: 'queued',
    createdAt: Date.now(),
    ...overrides,
  };
}

function writeValidPackage(): void {
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'spritesheet.webp'),
    Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP', 'binary'),
  );
  writeFileSync(
    join(packageDir, 'pet.json'),
    JSON.stringify({
      id: 'navi',
      displayName: 'Navi',
      description: 'Founder-builder pet',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
    }),
  );
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'nexus-pet-completion-'));
  codexHome = join(sandbox, '.codex');
  packageDir = join(codexHome, 'pets', 'navi');
  mission = {
    id: 'mission-pet',
    title: 'Create Navi',
    description: '',
    status: 'running',
    squadId: PET_STUDIO_SQUAD_ID,
    milestones: [],
    orchestratorSessionId: 'pet-session',
    createdAt: Date.now() - 100,
    updatedAt: Date.now() - 100,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
  };
  setStatus = vi.fn(() => ({ ...mission, status: 'done' }));
  markSubmitted = vi.fn(() => true);
  markConsumed = vi.fn(() => true);
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe('Pet Studio completion boundary', () => {
  it('completes only after validating a fresh v2 package under the Codex pet root', () => {
    writeValidPackage();
    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      getStores: stores,
    });

    expect(result).toEqual({
      handled: true,
      completed: true,
      packageDir: realpathSync(packageDir),
    });
    expect(setStatus).toHaveBeenCalledWith(mission.id, 'done');
    expect(markSubmitted).toHaveBeenCalledWith('handoff-pet');
    expect(markConsumed).toHaveBeenCalledWith('handoff-pet', mission.id);
  });

  it('keeps the mission running when the package is missing or malformed', () => {
    mkdirSync(join(codexHome, 'pets'), { recursive: true });
    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
      getStores: stores,
    });

    expect(result).toMatchObject({ handled: true, completed: false });
    expect(result?.error).toMatch(/ENOENT|ausente|validar/i);
    expect(setStatus).not.toHaveBeenCalled();
    expect(markSubmitted).not.toHaveBeenCalled();
  });

  it('rejects a stale package from before this mission', () => {
    writeValidPackage();
    mission.createdAt = Date.now();
    const stale = new Date(mission.createdAt - 5_000);
    utimesSync(join(packageDir, 'spritesheet.webp'), stale, stale);
    utimesSync(join(packageDir, 'pet.json'), stale, stale);

    const result = completePetStudioHandoff(handoff(), scope, {
      codexHome,
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
      { codexHome, getStores: stores },
    );

    expect(result).toMatchObject({ handled: true, completed: false });
    expect(result?.error).toMatch(/sessão Pet Maker/);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('does not alter the completion rules for any normal squad', () => {
    mission.squadId = 'software-development';
    expect(
      completePetStudioHandoff(handoff(), scope, {
        codexHome,
        getStores: stores,
      }),
    ).toBeNull();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
