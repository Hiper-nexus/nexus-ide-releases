/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MISSION_PREPARE_TITLE_MAX_CHARS } from '../../shared/mission-engine-contract';
import { MISSION_INTENT_GOAL_MAX_CHARS } from '../../shared/mission-intent';
import type { SquadAgent } from '../../shared/orch-types';
import {
  createEmptyMissionSetupDraft,
  missionSetupStorageKey,
  normalizeProjectContextPath,
  useMissionSetupStore,
} from './mission-setup-store';

const coordinator: SquadAgent = {
  id: 'mission-coordinator',
  agentName: 'Coordenar e revisar',
  category: 'orchestrator',
  cli: 'claude',
  model: 'sonnet',
  allowedSkills: [],
  allowedTools: null,
};

const implementer: SquadAgent = {
  id: 'interface-executor',
  agentName: 'Implementar interface',
  category: 'executor',
  cli: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  allowedSkills: [],
  allowedTools: ['Bash', 'Read', 'Edit'],
};

function resetStore(): void {
  useMissionSetupStore.setState({
    workspacePath: null,
    draft: createEmptyMissionSetupDraft(),
    persistence: { status: 'idle' },
    workspaceDrafts: {},
  });
}

/**
 * Storage double bound to `window`, not to `Storage.prototype`.
 *
 * Other suites replace the whole `window` global; a prototype spy then never
 * fires because the live `localStorage` no longer inherits from the patched
 * prototype. Swapping the property makes these tests independent of whatever
 * ran before them in the same worker.
 */
function withStorageFailure(overrides: {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
}): { restore: () => void; setItem: ReturnType<typeof vi.fn>; getItem: ReturnType<typeof vi.fn> } {
  const real = window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  const setItem = vi.fn(
    overrides.setItem ?? ((key: string, value: string) => real.setItem(key, value)),
  );
  const getItem = vi.fn(
    overrides.getItem ?? ((key: string) => real.getItem(key)),
  );
  const double = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (index: number) => real.key(index),
    removeItem: (key: string) => real.removeItem(key),
    getItem,
    setItem,
  } as unknown as Storage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => double,
  });
  return {
    setItem,
    getItem,
    restore: () => {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
      else Object.defineProperty(window, 'localStorage', { configurable: true, value: real });
    },
  };
}

function allObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allObjectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    allObjectKeys(child, keys);
  }
  return keys;
}

describe('mission setup draft store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    resetStore();
  });

  // Storage spies must be torn down after the test that installed them:
  // a beforeEach-only restore runs before the next spy, so a leaked spy
  // survives into other files sharing this worker.
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('ignores draft edits until a project workspace exists', () => {
    const store = useMissionSetupStore.getState();

    store.setObjective('Este texto não pode virar um rascunho sem projeto');
    store.setTitle('Sem projeto');
    store.setContextPaths(['src/App.tsx']);
    store.setRoster([coordinator, implementer]);
    store.setAdvancedLane('consult');
    store.setStep('team');

    expect(useMissionSetupStore.getState().draft).toEqual(
      createEmptyMissionSetupDraft(),
    );

    store.setWorkspace('/projects/alpha');
    expect(useMissionSetupStore.getState().draft).toEqual(
      createEmptyMissionSetupDraft(),
    );
  });

  it('persists independent versioned drafts under each canonical workspace path', () => {
    const store = useMissionSetupStore.getState();
    store.setWorkspace('/projects/alpha');
    store.setObjective('Entregar a navegação do produto');
    store.setTitle('Navegação do produto');
    store.setContextPaths(['src/App.tsx', 'docs/spec.md']);
    store.setRoster([coordinator, implementer]);
    store.setAdvancedLane('standard');
    store.setStep('team');

    const alphaRevision = useMissionSetupStore.getState().draft.revision;
    expect(alphaRevision).toBeGreaterThan(0);

    store.setWorkspace('/projects/beta');
    expect(useMissionSetupStore.getState().draft).toMatchObject({
      objective: '',
      title: '',
      contextPaths: [],
      roster: [],
      advanced: { lane: 'standard' },
      step: 'mission',
      revision: 0,
    });
    store.setObjective('Corrigir a busca');

    store.setWorkspace('/projects/alpha');
    expect(useMissionSetupStore.getState().draft).toMatchObject({
      objective: 'Entregar a navegação do produto',
      title: 'Navegação do produto',
      contextPaths: ['src/App.tsx', 'docs/spec.md'],
      roster: [coordinator, implementer],
      advanced: { lane: 'standard' },
      step: 'team',
      revision: alphaRevision,
    });

    expect(localStorage.getItem(missionSetupStorageKey('/projects/alpha'))).not.toBeNull();
    expect(localStorage.getItem(missionSetupStorageKey('/projects/beta'))).not.toBeNull();
  });

  it('clamps an oversized objective to the mission intent schema maximum before persisted reload', () => {
    const workspacePath = '/projects/objective-schema-limit';
    const expectedObjective = 'o'.repeat(MISSION_INTENT_GOAL_MAX_CHARS);

    useMissionSetupStore.getState().setWorkspace(workspacePath);
    useMissionSetupStore
      .getState()
      .setObjective(`${expectedObjective}beyond-the-schema-limit`);

    resetStore();
    useMissionSetupStore.getState().setWorkspace(workspacePath);

    expect(useMissionSetupStore.getState()).toMatchObject({
      draft: { objective: expectedObjective },
      persistence: { status: 'saved' },
    });
  });

  it('clamps an oversized title to the prepare schema maximum before persisted reload', () => {
    const workspacePath = '/projects/title-schema-limit';
    const expectedTitle = 't'.repeat(MISSION_PREPARE_TITLE_MAX_CHARS);

    useMissionSetupStore.getState().setWorkspace(workspacePath);
    useMissionSetupStore
      .getState()
      .setTitle(`${expectedTitle}beyond-the-schema-limit`);

    resetStore();
    useMissionSetupStore.getState().setWorkspace(workspacePath);

    expect(useMissionSetupStore.getState()).toMatchObject({
      draft: { title: expectedTitle },
      persistence: { status: 'saved' },
    });
  });

  it('resets only the selected workspace and keeps its revision monotonic', () => {
    const store = useMissionSetupStore.getState();
    store.setWorkspace('/projects/alpha');
    store.setObjective('Alpha');
    const beforeReset = useMissionSetupStore.getState().draft.revision;

    store.setWorkspace('/projects/beta');
    store.setObjective('Beta');
    store.resetWorkspace('/projects/alpha');

    expect(useMissionSetupStore.getState().draft.objective).toBe('Beta');
    store.setWorkspace('/projects/alpha');
    expect(useMissionSetupStore.getState().draft.objective).toBe('');
    expect(useMissionSetupStore.getState().draft.revision).toBe(beforeReset + 1);

    store.setWorkspace('/projects/beta');
    expect(useMissionSetupStore.getState().draft.objective).toBe('Beta');
  });

  it('fails closed for malformed, old, or authority-bearing storage payloads', () => {
    useMissionSetupStore.getState().setWorkspace('/projects/empty');
    expect(useMissionSetupStore.getState().persistence).toEqual({
      status: 'empty',
    });

    const malformedPath = '/projects/malformed';
    localStorage.setItem(missionSetupStorageKey(malformedPath), '{not-json');
    useMissionSetupStore.getState().setWorkspace(malformedPath);
    expect(useMissionSetupStore.getState().draft).toEqual(
      createEmptyMissionSetupDraft(),
    );
    expect(useMissionSetupStore.getState().persistence).toEqual({
      status: 'error',
      operation: 'read',
      reason: 'corrupt-payload',
    });


    const oldPath = '/projects/old';
    localStorage.setItem(
      missionSetupStorageKey(oldPath),
      JSON.stringify({ version: 0, workspacePath: oldPath, draft: {} }),
    );
    useMissionSetupStore.getState().setWorkspace(oldPath);
    expect(useMissionSetupStore.getState().draft).toEqual(
      createEmptyMissionSetupDraft(),
    );
    expect(useMissionSetupStore.getState().persistence).toEqual({
      status: 'error',
      operation: 'read',
      reason: 'unsupported-version',
    });


    const authorityPath = '/projects/authority';
    localStorage.setItem(
      missionSetupStorageKey(authorityPath),
      JSON.stringify({
        version: 1,
        workspacePath: authorityPath,
        draft: {
          ...createEmptyMissionSetupDraft(),
          reviewSha256: 'a'.repeat(64),
        },
      }),
    );
    useMissionSetupStore.getState().setWorkspace(authorityPath);
    expect(useMissionSetupStore.getState().draft).toEqual(
      createEmptyMissionSetupDraft(),
    );

    const planningAuthorityPath = '/projects/planning-authority';
    localStorage.setItem(
      missionSetupStorageKey(planningAuthorityPath),
      JSON.stringify({
        version: 1,
        workspacePath: planningAuthorityPath,
        draft: {
          ...createEmptyMissionSetupDraft(),
          roster: [{ ...coordinator, ownsPlanDocs: true }],
        },
      }),
    );
    useMissionSetupStore.getState().setWorkspace(planningAuthorityPath);
    expect(useMissionSetupStore.getState().draft).toEqual(
      createEmptyMissionSetupDraft(),
    );

    const hostPathDraft = '/projects/host-path';
    localStorage.setItem(
      missionSetupStorageKey(hostPathDraft),
      JSON.stringify({
        version: 1,
        workspacePath: hostPathDraft,
        draft: {
          ...createEmptyMissionSetupDraft(),
          contextPaths: ['/tmp/outside.txt'],
        },
      }),
    );
    useMissionSetupStore.getState().setWorkspace(hostPathDraft);
    expect(useMissionSetupStore.getState().draft).toEqual(
      createEmptyMissionSetupDraft(),
    );
  });

  it('persists operator draft fields only, never review or runtime authority', () => {
    const store = useMissionSetupStore.getState();
    store.setWorkspace('/projects/alpha');
    store.setObjective('Criar o fluxo');
    store.setRoster([coordinator, implementer]);

    const persisted = JSON.parse(
      localStorage.getItem(missionSetupStorageKey('/projects/alpha')) ?? '{}',
    ) as unknown;
    const keys = allObjectKeys(persisted);
    for (const forbidden of [
      'review',
      'reviewSha256',
      'approval',
      'receipt',
      'sessionId',
      'snapshot',
      'authority',
      'ownsPlanDocs',
      'loading',
      'error',
      'promise',
      'credentials',
      'accounts',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('copies roster members and nested scopes on every write', () => {
    const store = useMissionSetupStore.getState();
    store.setWorkspace('/projects/alpha');
    const callerRoster = [
      { ...implementer, allowedTools: [...(implementer.allowedTools ?? [])] },
    ];

    store.setRoster(callerRoster);
    const storedRoster = useMissionSetupStore.getState().draft.roster;
    expect(storedRoster).not.toBe(callerRoster);
    expect(storedRoster[0]).not.toBe(callerRoster[0]);
    expect(storedRoster[0]?.allowedTools).not.toBe(callerRoster[0]?.allowedTools);

    callerRoster[0]!.agentName = 'Mutação do chamador';
    callerRoster[0]!.allowedTools!.push('Write');
    expect(useMissionSetupStore.getState().draft.roster[0]).toMatchObject({
      agentName: 'Implementar interface',
      allowedTools: ['Bash', 'Read', 'Edit'],
    });
  });

  it('increments revision for every contract-changing field but not step navigation', () => {
    const store = useMissionSetupStore.getState();
    store.setWorkspace('/projects/alpha');
    expect(useMissionSetupStore.getState().draft.revision).toBe(0);

    store.setObjective('Objetivo');
    const afterObjective = useMissionSetupStore.getState().draft.revision;
    store.setContextPaths(['src/App.tsx']);
    const afterContext = useMissionSetupStore.getState().draft.revision;
    store.setRoster([coordinator, implementer]);
    const afterRoster = useMissionSetupStore.getState().draft.revision;
    store.setAdvancedLane('consult');
    const afterAdvanced = useMissionSetupStore.getState().draft.revision;
    store.setStep('team');

    expect([
      afterObjective,
      afterContext,
      afterRoster,
      afterAdvanced,
    ]).toEqual([1, 2, 3, 4]);
    expect(useMissionSetupStore.getState().draft.revision).toBe(4);
  });

  it('keeps the in-memory draft usable when localStorage is unavailable', () => {
    const storage = withStorageFailure({
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });
    try {
      const store = useMissionSetupStore.getState();
      expect(() => store.setWorkspace('/projects/alpha')).not.toThrow();
      expect(() => store.setObjective('Rascunho preservado')).not.toThrow();
      expect(useMissionSetupStore.getState().draft.objective).toBe(
        'Rascunho preservado',
      );
      expect(storage.setItem).toHaveBeenCalled();
    } finally {
      storage.restore();
    }
  });

  it('reports read failures and retries without pretending the draft is empty', () => {
    const workspacePath = '/projects/read-retry';
    localStorage.setItem(
      missionSetupStorageKey(workspacePath),
      JSON.stringify({
        version: 1,
        workspacePath,
        draft: {
          ...createEmptyMissionSetupDraft(),
          objective: 'Rascunho salvo antes da falha',
          revision: 3,
        },
      }),
    );
    const storage = withStorageFailure({
      getItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });

    const store = useMissionSetupStore.getState();
    store.setWorkspace(workspacePath);

    expect(useMissionSetupStore.getState()).toMatchObject({
      draft: createEmptyMissionSetupDraft(),
      persistence: {
        status: 'error',
        operation: 'read',
        reason: 'read-failed',
      },
    });

    storage.restore();
    store.retryPersistence();

    expect(useMissionSetupStore.getState()).toMatchObject({
      draft: {
        objective: 'Rascunho salvo antes da falha',
        revision: 3,
      },
      persistence: { status: 'saved' },
    });
  });

  it('keeps failed writes in memory per workspace and persists them on retry', () => {
    const storage = withStorageFailure({
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });
    const store = useMissionSetupStore.getState();

    store.setWorkspace('/projects/alpha');
    store.setObjective('Rascunho mantido somente na memória');

    expect(useMissionSetupStore.getState()).toMatchObject({
      draft: { objective: 'Rascunho mantido somente na memória' },
      persistence: {
        status: 'error',
        operation: 'write',
        reason: 'quota-exceeded',
      },
    });

    store.setWorkspace('/projects/beta');
    store.setWorkspace('/projects/alpha');
    expect(useMissionSetupStore.getState().draft.objective).toBe(
      'Rascunho mantido somente na memória',
    );

    storage.restore();
    store.retryPersistence();

    expect(useMissionSetupStore.getState().persistence).toEqual({
      status: 'saved',
    });
    expect(
      JSON.parse(
        localStorage.getItem(missionSetupStorageKey('/projects/alpha')) ?? '{}',
      ),
    ).toMatchObject({
      draft: { objective: 'Rascunho mantido somente na memória' },
    });
  });
});

describe('normalizeProjectContextPath', () => {
  it('normalizes project-relative separators without accepting host paths', () => {
    expect(normalizeProjectContextPath('./src\\App.tsx')).toBe('src/App.tsx');
    expect(normalizeProjectContextPath('docs/spec.md')).toBe('docs/spec.md');
  });

  it.each([
    '/etc/passwd',
    'C:\\Users\\name\\secret.txt',
    '\\\\server\\share\\secret.txt',
    '../outside.txt',
    'src/../../outside.txt',
    'file:///tmp/outside.txt',
    'https://example.com/spec.md',
    '~/private.txt',
    'src//App.tsx',
    '.',
    '',
  ])('rejects non-project path %s', (path) => {
    expect(normalizeProjectContextPath(path)).toBeNull();
  });
});
