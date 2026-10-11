/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { tiptapJsonToMarkdown } from '../ComposerTiptapEditor';
import { deliverDictationToClaim } from '../../voice/dictation-target';
import { objectivePlainText } from '../../../shared/mission-identity';
import { MISSION_INTENT_GOAL_MAX_CHARS } from '../../../shared/mission-intent';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { AccountInfo } from '../../../shared/account-types';
import {
  missionPrepareRequestSchema,
  type MissionReview,
  type MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import {
  strictSquadAgentSchema,
  type SquadAgent,
} from '../../../shared/orch-types';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import {
  DEFAULT_ORCH_SETTINGS,
  type OrchSettings,
} from '../../../shared/settings-types';
import type { AdapterInfo } from '../../../shared/types';
import { missionRuntimeReadiness } from '../../orch/mission-runtime-readiness';
import * as missionAttachments from '../../lib/mission-attachments';
import { planRemoveRosterAgent } from '../../orch/mission-roster-customize';
import {
  missionSetupStorageKey,
  useMissionSetupStore,
} from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useProviderStore } from '../../state/provider-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import {
  MissionSetup,
  missionPrepareRequestFromDraft,
} from './MissionSetup';
import {
  buildRecommendedMissionRoster,
  missionRosterIssue,
} from './TeamStep';
import { MissionAttachmentPicker } from './MissionAttachmentPicker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = {
  path: '/projects/nexus',
  name: 'nexus',
  lastOpenedAt: 1,
};
const OTHER_WORKSPACE = {
  path: '/projects/other',
  name: 'other',
  lastOpenedAt: 2,
};

function adapter(
  id: string,
  overrides: Partial<AdapterInfo> = {},
): AdapterInfo {
  return {
    id,
    kind: 'cli-pty',
    label: id === 'claude' ? 'Claude' : 'Codex',
    icon: id === 'claude' ? 'C' : 'X',
    models: {
      list: [id === 'claude' ? 'sonnet' : 'gpt-5.6-sol'],
      default: id === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
    },
    installed: true,
    installCommand: '',
    idleTimeoutMs: 1_000,
    orchestratorCapable: id === 'claude',
    taskHandoffCapable: true,
    missionControlCapable: id === 'claude' || id === 'codex',
    autonomousWorkspaceWriteCapable: true,
    orchestrationEvidence: id === 'claude' ? 'verified' : 'unsupported',
    capabilities: {
      launchable: true,
      promptInjectable: true,
      statusObservable: true,
      resumable: true,
      autonomousReadOnly: true,
      governedWriter: true,
      verifiedMaestro: id === 'claude',
    },
    ...overrides,
  };
}

const CLAUDE = adapter('claude');
const CODEX = adapter('codex');

function provider(item: AdapterInfo): ProviderSettingsInfo {
  return {
    adapterId: item.id,
    label: item.label,
    icon: item.icon,
    kind: item.kind,
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: item.id,
    defaultModel: item.models.default,
    models: [...item.models.list],
    authReadyModels: [...item.models.list],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'oauth',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: item.id,
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: item.id === 'codex' ? 'high' : '',
    efforts: item.id === 'codex' ? ['medium', 'high'] : [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
  };
}

const PROVIDERS = [provider(CLAUDE), provider(CODEX)];
const ACCOUNTS: AccountInfo[] = [];
const ORCH_SETTINGS: OrchSettings = {
  ...DEFAULT_ORCH_SETTINGS,
  defaultAdapterId: 'claude',
  defaultModel: 'sonnet',
  squadCliPolicy: 'operator-choice',
};

const REVIEW_ROSTER: SquadAgent[] = [
  {
    id: 'mission-coordinator',
    agentName: 'Coordenar e revisar',
    category: 'orchestrator',
    cli: 'claude',
    model: 'sonnet',
    allowedSkills: [],
    allowedTools: null,
  },
  {
    id: 'interface-executor',
    agentName: 'Implementar interface',
    category: 'executor',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    allowedSkills: [],
    allowedTools: ['Bash', 'Read', 'Edit'],
  },
  {
    id: 'engine-executor',
    agentName: 'Implementar motor',
    category: 'executor',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    allowedSkills: [],
    allowedTools: ['Bash', 'Read', 'Edit'],
  },
  {
    id: 'result-reviewer',
    agentName: 'Verificar o resultado',
    category: 'reviewer',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    allowedSkills: [],
    allowedTools: ['Bash', 'Read'],
  },
];

const REVIEW: MissionReview = {
  missionId: 'mission-reviewed',
  title: 'Fluxo revisado pelo processo principal',
  objective: 'Entrega exata devolvida pela revisão principal',
  workspaceLabel: 'nexus (/projects/nexus)',
  contextPaths: ['src/renderer/App.tsx'],
  roster: REVIEW_ROSTER,
  permissions: [
    {
      id: 'workspace-write',
      label: 'Alterar arquivos do projeto',
      detail: 'Somente dentro da pasta escolhida.',
    },
  ],
  warnings: ['A navegação atual será substituída.'],
  reviewSha256: 'a'.repeat(64),
  createdAt: 1_787_000_000_000,
};

const SNAPSHOT: MissionSnapshot = {
  id: 'mission-board-exact',
  title: REVIEW.title,
  objective: REVIEW.objective,
  workspaceLabel: REVIEW.workspaceLabel,
  state: 'running',
  progress: { completed: 0, total: 4 },
  agents: [],
  edges: [],
  units: [],
  allowedActions: ['direct', 'stop'],
  version: 1,
  updatedAt: REVIEW.createdAt + 1,
};

const MISSION_LANE_GUIDANCE_CASES = [
  {
    lane: 'standard',
    label: 'Construir ou alterar o produto',
    authority: [/editar arquivos/i, /dentro da pasta/i],
  },
  {
    lane: 'consult',
    label: 'Investigar sem alterar arquivos',
    authority: [
      /somente leitura/i,
      /(?:sem alterar|não (?:pode )?alterar) arquivos/i,
    ],
  },
  {
    lane: 'plan',
    label: 'Preparar um plano',
    authority: [
      /somente leitura/i,
      /preparar um plano/i,
      /(?:sem alterar|não (?:pode )?alterar) arquivos/i,
    ],
  },
  {
    lane: 'ops',
    label: 'Operar infraestrutura',
    authority: [
      /ações de infraestrutura/i,
      /não (?:pode )?alterar (?:o repositório|arquivos do projeto)/i,
    ],
  },
] as const;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const api = {
  listAdapters: vi.fn(async () => [CLAUDE, CODEX]),
  listProviders: vi.fn(async () => PROVIDERS),
  listAccounts: vi.fn(async () => ACCOUNTS),
  getOrchSettings: vi.fn(async () => ORCH_SETTINGS),
  prepare: vi.fn<Window['nexus']['mission']['prepare']>(async () => REVIEW),
  start: vi.fn<Window['nexus']['mission']['start']>(async () => SNAPSHOT),
  removeMission: vi.fn(async () => ({ removed: true })),
  importMissionAttachment: vi.fn(async (name: string) => ({
    ok: true,
    path: `.nexus/attachments/mission-context/token-${name}`,
  })),
  importDroppedUri: vi.fn(async (uri: string) => ({
    ok: true,
    path: `.nexus/attachments/mission-context/token-${uri.split('/').at(-1)}`,
  })),
};

const initialWorkspaceState = useWorkspaceStore.getState();
const mountedRoots = new Set<Root>();

function installNexusApi(): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: { list: api.listAdapters },
      providers: { list: api.listProviders },
      accounts: { list: api.listAccounts },
      settings: { orchGet: api.getOrchSettings },
      mission: { prepare: api.prepare, start: api.start },
      orch: { removeMission: api.removeMission },
      files: {
        importMissionAttachment: api.importMissionAttachment,
        importDroppedUri: api.importDroppedUri,
        pathForFile: () => '',
      },
    } as unknown as Window['nexus'],
  });
}

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => root.render(node));
  return host;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Observe the real digest/import promises; microtask flushes do not await WebCrypto. */
function observeAttachmentWork(): () => Promise<void> {
  const contentKeys = vi.spyOn(missionAttachments, 'missionAttachmentContentKey');
  const stagedFiles = vi.spyOn(missionAttachments, 'stageMissionAttachment');
  return async () => {
    await act(async () => {
      await Promise.all(contentKeys.mock.results.map((result) => result.value));
      await Promise.all(stagedFiles.mock.results.map((result) => result.value));
    });
  };
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(name),
  );
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

function buttonByAriaLabel(
  host: HTMLElement,
  label: string,
): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    (item) => item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Button not found by aria-label: ${label}`);
  return found;
}

function fieldByLabel<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
  host: HTMLElement,
  labelText: string,
): T {
  const label = Array.from(host.querySelectorAll('label')).find((item) =>
    item.textContent?.includes(labelText),
  );
  const id = label?.htmlFor;
  const candidate = id ? document.getElementById(id) : null;
  const field = candidate && host.contains(candidate) ? (candidate as T) : null;
  if (!field) throw new Error(`Field not found: ${labelText}`);
  return field;
}

/** F-1170: o objetivo é o editor rich-text (Tiptap): superfície role=textbox. */
type ObjectiveField = HTMLElement & { editor: Editor };

/** O rótulo aponta (htmlFor) para a superfície do editor, nomeada por ele. */
function objectiveField(host: HTMLElement, labelText: string): ObjectiveField {
  const label = Array.from(host.querySelectorAll('label')).find((item) =>
    item.textContent?.includes(labelText),
  );
  const field = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (
    !field ||
    !host.contains(field) ||
    field.getAttribute('role') !== 'textbox' ||
    field.getAttribute('aria-labelledby') !== label?.id ||
    !(field as ObjectiveField).editor
  ) {
    throw new Error(`Objective editor not found: ${labelText}`);
  }
  return field as ObjectiveField;
}

/** Valor do objetivo: o markdown canônico do editor (o que vai ao store). */
function fieldValue(field: ObjectiveField): string {
  return tiptapJsonToMarkdown(field.editor.getJSON());
}

function isObjectiveDisabled(field: ObjectiveField): boolean {
  const off =
    field.getAttribute('contenteditable') === 'false' &&
    field.getAttribute('aria-disabled') === 'true' &&
    !field.editor.isEditable;
  const on =
    field.getAttribute('contenteditable') === 'true' &&
    !field.hasAttribute('aria-disabled') &&
    field.editor.isEditable;
  if (off === on) throw new Error('Objective editor disabled state is inconsistent');
  return off;
}

function enterText(
  field: HTMLInputElement | HTMLTextAreaElement | ObjectiveField,
  value: string,
): void {
  if ('editor' in field) {
    // Digitação do operador: troca o documento por texto literal, cursor no fim.
    const { editor } = field;
    act(() => {
      const { schema } = editor.state;
      const paragraphs = value
        .split('\n')
        .map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
      const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraphs);
      editor.view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)));
    });
    return;
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      'value',
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function renderAtTeam(): Promise<HTMLElement> {
  const host = render(<MissionSetup />);
  await flush();
  enterText(
    objectiveField(
      host,
      'O que você quer que a equipe entregue?',
    ),
    'Criar um fluxo simples de missão',
  );
  act(() => button(host, 'Continuar para equipe').click());
  await flush();
  return host;
}

async function renderAtReview(): Promise<HTMLElement> {
  const host = await renderAtTeam();
  act(() => button(host, 'Continuar para revisão').click());
  await flush();
  return host;
}

const geometry = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  // F-1170: editor Tiptap real no objetivo; o jsdom só não tem geometria.
  for (const [name, value] of [['getClientRects', () => []], ['getBoundingClientRect', () => new DOMRect()]] as const) {
    geometry.set(name, Object.getOwnPropertyDescriptor(Range.prototype, name));
    Object.defineProperty(Range.prototype, name, { configurable: true, value });
  }
  localStorage.clear();
  for (const mock of Object.values(api)) mock.mockClear();
  api.listAdapters.mockResolvedValue([CLAUDE, CODEX]);
  api.listProviders.mockResolvedValue(PROVIDERS);
  api.listAccounts.mockResolvedValue(ACCOUNTS);
  api.getOrchSettings.mockResolvedValue(ORCH_SETTINGS);
  api.prepare.mockResolvedValue(REVIEW);
  api.start.mockResolvedValue(SNAPSHOT);
  api.importMissionAttachment.mockReset().mockImplementation(async (name: string) => ({
    ok: true,
    path: `.nexus/attachments/mission-context/token-${name}`,
  }));
  installNexusApi();

  useWorkspaceStore.setState({
    ...initialWorkspaceState,
    current: WORKSPACE,
    recents: [WORKSPACE],
    hydrated: true,
  });
  useMissionSetupStore.setState({
    workspacePath: WORKSPACE.path,
    draft: {
      objective: '',
      title: '',
      contextPaths: [],
      roster: [],
      advanced: { lane: 'standard' },
      step: 'mission',
      revision: 0,
    },
    persistence: { status: 'idle' },
    workspaceDrafts: {},
  });
  useProductNavigationStore.setState({
    destination: { kind: 'mission-setup' },
    settingsReturnDestination: null,
  });
  useProviderStore.setState({ providers: [] });
});

afterEach(() => {
  for (const root of mountedRoots) {
    act(() => root.unmount());
  }
  mountedRoots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  restoreStorageDoubles();
  for (const [name, original] of geometry) {
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  geometry.clear();
});

const installedStorageDoubles = new Set<() => void>();

/**
 * Storage double bound to `window`, not to `Storage.prototype`.
 *
 * Other suites replace the whole `window` global; a prototype spy then never
 * fires because the live `localStorage` no longer inherits from the patched
 * prototype. Swapping the property keeps these tests deterministic no matter
 * what ran before them in the same worker.
 */
function withStorageFailure(overrides: {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
}): { restore: () => void } {
  const real = window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  const double = {
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
    key: (index: number) => real.key(index),
    removeItem: (key: string) => real.removeItem(key),
    getItem: overrides.getItem ?? ((key: string) => real.getItem(key)),
    setItem:
      overrides.setItem ?? ((key: string, value: string) => real.setItem(key, value)),
  } as unknown as Storage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => double,
  });
  const restore = (): void => {
    if (!installedStorageDoubles.delete(restore)) return;
    if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    else
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: real,
      });
  };
  installedStorageDoubles.add(restore);
  return { restore };
}

function restoreStorageDoubles(): void {
  for (const restore of [...installedStorageDoubles].reverse()) restore();
  installedStorageDoubles.clear();
}

describe('recommended mission team', () => {
  it('uses the existing secret-free readiness policy and produces strict stable roles', () => {
    const readiness = missionRuntimeReadiness(
      [CODEX, CLAUDE],
      PROVIDERS,
      ACCOUNTS,
      ORCH_SETTINGS.squadCliPolicy,
    );
    const roster = buildRecommendedMissionRoster({
      readiness,
      providers: PROVIDERS,
      accounts: ACCOUNTS,
      settings: ORCH_SETTINGS,
      objective: 'Construir a experiência guiada de missão',
      lane: 'standard',
    });

    expect(roster?.map(({ id, agentName, category, cli }) => ({
      id,
      agentName,
      category,
      cli,
    }))).toEqual([
      {
        id: 'mission-coordinator',
        agentName: 'Coordenar e revisar',
        category: 'orchestrator',
        cli: 'claude',
      },
      {
        id: 'interface-executor',
        agentName: 'Implementar interface',
        category: 'executor',
        cli: 'codex',
      },
      {
        id: 'engine-executor',
        agentName: 'Implementar motor',
        category: 'executor',
        cli: 'codex',
      },
      {
        id: 'result-reviewer',
        agentName: 'Verificar o resultado',
        category: 'reviewer',
        cli: 'codex',
      },
    ]);
    expect(strictSquadAgentSchema.array().safeParse(roster).success).toBe(true);
  });

  it('não recomenda Claude login-needed como Maestro quando outra CLI está sentada', () => {
    const providers: ProviderSettingsInfo[] = [
      {
        ...provider(CLAUDE),
        authStrategy: 'login-needed',
        loginHint:
          'Rode `claude auth login` no terminal. A sessão fica no Keychain.',
      },
      provider(CODEX),
    ];
    const readiness = missionRuntimeReadiness(
      [CODEX, CLAUDE],
      providers,
      ACCOUNTS,
      ORCH_SETTINGS.squadCliPolicy,
    );
    const roster = buildRecommendedMissionRoster({
      readiness,
      providers,
      accounts: ACCOUNTS,
      settings: ORCH_SETTINGS,
      objective: 'Construir a experiência guiada de missão',
      lane: 'standard',
    });
    expect(
      roster?.find((agent) => agent.category === 'orchestrator')?.cli,
    ).toBe('codex');
  });

  it('selects Codex over alphabetically earlier AGY and prefers workers without pending login', () => {
    const agy = adapter('agy', { missionControlCapable: false });
    const cursor = adapter('cursor-agent', { missionControlCapable: false });
    const adapters = [agy, CLAUDE, CODEX, cursor];
    const providers: ProviderSettingsInfo[] = adapters.map((item) => ({
      ...provider(item),
      ...(item.id === 'claude' || item.id === 'cursor-agent'
        ? { authStrategy: 'login-needed' as const, authReadyModels: [] }
        : {}),
    }));
    const readiness = missionRuntimeReadiness(adapters, providers, []);
    const roster = buildRecommendedMissionRoster({
      readiness,
      providers,
      accounts: [],
      settings: ORCH_SETTINGS,
      objective: 'Pergunte aos panes quanto é 2+2 e consolide as respostas',
      lane: 'standard',
    });

    expect(roster?.find((agent) => agent.category === 'orchestrator')?.cli)
      .toBe('codex');
    expect(roster?.filter((agent) => agent.category !== 'orchestrator').length)
      .toBeGreaterThan(0);
    expect(roster?.every((agent) => agent.cli === 'codex')).toBe(true);
    expect(readiness.qualifiedWorkers.map((item) => item.id))
      .toEqual(['agy', 'claude', 'codex', 'cursor-agent']);
  });

  it('prefers workers with physical Nexus MCP over ready PTY-only alternatives', () => {
    const cursor = adapter('cursor-agent', { missionControlCapable: false });
    const deepseek = adapter('deepseek', { missionControlCapable: true });
    const adapters = [CODEX, cursor, deepseek];
    const providers = adapters.map(provider);
    const readiness = missionRuntimeReadiness(adapters, providers, []);
    const roster = buildRecommendedMissionRoster({
      readiness,
      providers,
      accounts: [],
      settings: { ...ORCH_SETTINGS, defaultAdapterId: 'codex' },
      objective: 'Construir a experiência guiada de missão',
      lane: 'standard',
    });

    expect(roster?.find((agent) => agent.category === 'orchestrator')?.cli)
      .toBe('codex');
    expect(roster?.filter((agent) => agent.category !== 'orchestrator')
      .map((agent) => agent.cli)).toEqual(['codex', 'deepseek', 'codex']);
    expect(readiness.qualifiedWorkers.map((item) => item.id))
      .toEqual(['codex', 'cursor-agent', 'deepseek']);
  });

  it.each(['subscription', 'login-needed'] as const)(
    'keeps a PTY-only worker with %s available when no alternative exists',
    (authStrategy) => {
      const cursor = adapter('cursor-agent', { missionControlCapable: false });
      const providers: ProviderSettingsInfo[] = [
        provider(CLAUDE),
        { ...provider(cursor), authStrategy, authReadyModels: [] },
      ];
      const readiness = missionRuntimeReadiness([CLAUDE, cursor], providers, []);
      const roster = buildRecommendedMissionRoster({
        readiness,
        providers,
        accounts: [],
        settings: ORCH_SETTINGS,
        objective: 'Verifique os arquivos do projeto',
        lane: 'standard',
      });

      expect(roster).not.toBeNull();
      expect(roster?.filter((agent) => agent.category !== 'orchestrator')
        .every((agent) => agent.cli === 'cursor-agent')).toBe(true);
    },
  );

  it('não reprova mais o roster por modelo sem autenticação (doutrina fluxo-por-padrão)', () => {
    // Antes, trocar o modelo para um valor fora de authReadyModels travava o
    // "Continuar para revisão". Agora o modelo é assunto da própria CLI no
    // terminal; o roster só bloqueia por forma ou ferramenta não instalada.
    const readiness = missionRuntimeReadiness(
      [CLAUDE, CODEX],
      PROVIDERS,
      ACCOUNTS,
      ORCH_SETTINGS.squadCliPolicy,
    );
    const changedRoster = REVIEW_ROSTER.map((agent) =>
      agent.id === 'interface-executor'
        ? { ...agent, model: 'modelo-sem-autenticacao' }
        : agent,
    );

    expect(
      missionRosterIssue({
        roster: changedRoster,
        lane: 'standard',
        readiness,
        providers: PROVIDERS,
        accounts: ACCOUNTS,
      }),
    ).toBeNull();

    const uninstalledRoster = REVIEW_ROSTER.map((agent) =>
      agent.id === 'interface-executor'
        ? { ...agent, cli: 'ferramenta-inexistente' }
        : agent,
    );
    expect(
      missionRosterIssue({
        roster: uninstalledRoster,
        lane: 'standard',
        readiness,
        providers: PROVIDERS,
        accounts: ACCOUNTS,
      }),
    ).toMatch(/não está instalada/i);
  });

  it('blocks a standard team that drops its executor or reviewer', () => {
    const readiness = missionRuntimeReadiness(
      [CLAUDE, CODEX],
      PROVIDERS,
      ACCOUNTS,
      ORCH_SETTINGS.squadCliPolicy,
    );
    const common = {
      lane: 'standard' as const,
      readiness,
      providers: PROVIDERS,
      accounts: ACCOUNTS,
    };

    expect(
      missionRosterIssue({
        ...common,
        roster: [REVIEW_ROSTER[0]!, REVIEW_ROSTER[3]!],
      }),
    ).toMatch(/executor|implementa/i);
    expect(
      missionRosterIssue({
        ...common,
        roster: [REVIEW_ROSTER[0]!, REVIEW_ROSTER[1]!],
      }),
    ).toMatch(/verific|revis/i);
  });

  it('keeps compatibility with the existing coordinator/removal guard', () => {
    expect(
      planRemoveRosterAgent(REVIEW_ROSTER, 'mission-coordinator'),
    ).toMatchObject({ ok: false });
    expect(
      planRemoveRosterAgent(
        REVIEW_ROSTER.slice(0, 2),
        'interface-executor',
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('mission prepare request boundary', () => {
  it('preserves role instructions and tool grants in the renderer request', () => {
    const request = missionPrepareRequestFromDraft({
      objective: 'Implementar a recuperação do fluxo',
      title: '',
      contextPaths: [],
      roster: [
        {
          ...REVIEW_ROSTER[1]!,
          instructions:
            'Implemente a integração sem alterar o contrato público.',
          allowedTools: ['Read', 'Edit'],
        },
      ],
      advanced: { lane: 'standard' },
      step: 'team',
      revision: 4,
    });

    expect(request.roster[0]).toMatchObject({
      instructions: 'Implemente a integração sem alterar o contrato público.',
      allowedTools: ['Read', 'Edit'],
    });
  });

  it('passes declared grants through without a lane ceiling, keeping customized role identity', () => {
    const request = missionPrepareRequestFromDraft({
      objective: 'Investigar a integração sem alterar arquivos',
      title: '',
      contextPaths: [],
      roster: [
        {
          ...REVIEW_ROSTER[0]!,
          agentName: 'Coordenar investigação personalizada',
          providerId: 'claude-subscription',
          model: 'sonnet-enterprise',
          instructions: 'Consolide somente evidências verificadas.',
        },
        {
          ...REVIEW_ROSTER[1]!,
          agentName: 'Especialista da integração',
          providerId: 'codex-subscription',
          model: 'gpt-enterprise',
          instructions: 'Inspecione o contrato de pagamentos sem modificá-lo.',
        },
      ],
      advanced: { lane: 'consult' },
      step: 'team',
      revision: 5,
    });

    // Sem teto de lane, os grants declarados passam adiante: o coordenador
    // fica irrestrito (null) e o executor mantém ['Bash', 'Read', 'Edit'].
    expect(request.roster).toEqual([
      {
        id: 'mission-coordinator',
        agentName: 'Coordenar investigação personalizada',
        category: 'orchestrator',
        cli: 'claude',
        providerId: 'claude-subscription',
        model: 'sonnet-enterprise',
        instructions: 'Consolide somente evidências verificadas.',
        allowedSkills: [],
        allowedTools: null,
      },
      {
        id: 'interface-executor',
        agentName: 'Especialista da integração',
        category: 'executor',
        cli: 'codex',
        providerId: 'codex-subscription',
        model: 'gpt-enterprise',
        effort: 'high',
        instructions: 'Inspecione o contrato de pagamentos sem modificá-lo.',
        allowedSkills: [],
        allowedTools: ['Bash', 'Read', 'Edit'],
      },
    ]);
  });
});

describe('MissionSetup', () => {
  it('loads all secret-free catalogs concurrently and keeps advanced controls collapsed', async () => {
    const adaptersPending = deferred<AdapterInfo[]>();
    const providersPending = deferred<ProviderSettingsInfo[]>();
    const accountsPending = deferred<AccountInfo[]>();
    const settingsPending = deferred<OrchSettings>();
    api.listAdapters.mockReturnValueOnce(adaptersPending.promise);
    api.listProviders.mockReturnValueOnce(providersPending.promise);
    api.listAccounts.mockReturnValueOnce(accountsPending.promise);
    api.getOrchSettings.mockReturnValueOnce(settingsPending.promise);

    const host = render(<MissionSetup />);
    expect(api.listAdapters).toHaveBeenCalledTimes(1);
    expect(api.listProviders).toHaveBeenCalledTimes(1);
    expect(api.listAccounts).toHaveBeenCalledTimes(1);
    expect(api.getOrchSettings).toHaveBeenCalledTimes(1);

    const labels = Array.from(
      host.querySelectorAll('.mission-setup__progress-label'),
    ).map((item) => item.textContent);
    expect(labels).toEqual(['Missão', 'Equipe', 'Revisar']);
    expect(
      host.querySelector('[aria-current="step"]')?.textContent,
    ).toContain('Missão');

    const advanced = Array.from(host.querySelectorAll('details')).find(
      (item) => item.querySelector('summary')?.textContent === 'Avançado',
    );
    expect(advanced?.open).toBe(false);

    await act(async () => {
      adaptersPending.resolve([CLAUDE, CODEX]);
      providersPending.resolve(PROVIDERS);
      accountsPending.resolve(ACCOUNTS);
      settingsPending.resolve(ORCH_SETTINGS);
      await Promise.all([
        adaptersPending.promise,
        providersPending.promise,
        accountsPending.promise,
        settingsPending.promise,
      ]);
    });
  });

  it('announces objective validation before moving focus and repeats the alert', async () => {
    const host = render(<MissionSetup />);
    await flush();

    const project = fieldByLabel<HTMLInputElement>(
      host,
      'Pasta do projeto',
    );
    expect(project.readOnly).toBe(true);
    expect(project.value).toBe(WORKSPACE.path);

    const objective = objectiveField(
      host,
      'O que você quer que a equipe entregue?',
    );
    let errorWasCommittedBeforeFocus = false;
    objective.addEventListener('focus', () => {
      const error = host.querySelector<HTMLElement>(
        '#mission-objective-error[role="alert"]',
      );
      errorWasCommittedBeforeFocus =
        error?.textContent?.includes(
          'Descreva a entrega antes de continuar.',
        ) === true;
    });

    const continueButton = button(host, 'Continuar para equipe');
    act(() => continueButton.click());
    const firstError = host.querySelector<HTMLElement>(
      '#mission-objective-error[role="alert"]',
    );
    expect(firstError?.textContent).toContain(
      'Descreva a entrega antes de continuar.',
    );
    expect(errorWasCommittedBeforeFocus).toBe(true);
    expect(document.activeElement).toBe(objective);
    expect(objective.getAttribute('aria-invalid')).toBe('true');

    act(() => {
      continueButton.focus();
      continueButton.click();
    });
    const repeatedError = host.querySelector<HTMLElement>(
      '#mission-objective-error[role="alert"]',
    );
    expect(repeatedError).not.toBe(firstError);
    expect(document.activeElement).toBe(objective);
  });

  it('uses the workspace picker and adopts the canonical path it publishes', async () => {
    const pick = vi.fn(async () => {
      useWorkspaceStore.setState({ current: OTHER_WORKSPACE });
    });
    useWorkspaceStore.setState({ current: null, pick });
    const host = render(<MissionSetup />);
    await flush();

    act(() => button(host, 'Escolher pasta').click());
    await flush();

    expect(pick).toHaveBeenCalledTimes(1);
    const project = host.querySelector<HTMLElement>('#express-workspace-name');
    expect(project?.textContent).toBe(OTHER_WORKSPACE.name);
    expect(project?.title).toBe(OTHER_WORKSPACE.path);
    expect(useMissionSetupStore.getState().workspacePath).toBe(
      OTHER_WORKSPACE.path,
    );
  });

  it('sem pasta, a entrada é o Expresso e a ideia escrita é preservada', async () => {
    useMissionSetupStore.setState({
      workspacePath: WORKSPACE.path,
      draft: {
        objective: 'Quero um sistema de agendamento para minha barbearia',
        title: '',
        contextPaths: [],
        roster: [],
        advanced: { lane: 'standard' },
        step: 'mission',
        revision: 0,
      },
    });
    useWorkspaceStore.setState({ current: null });
    const host = render(<MissionSetup />);
    await flush();

    // Fechar o projeto volta à entrada expressa sem descartar a ideia.
    const objective = objectiveField(host, 'Seu pedido');
    expect(isObjectiveDisabled(objective)).toBe(false);
    expect(fieldValue(objective)).toBe(
      'Quero um sistema de agendamento para minha barbearia',
    );
    expect(
      button(host, 'Escolher pasta e iniciar').disabled,
    ).toBe(false);
  });

  it('permite escrever a ideia antes da pasta e pede a pasta ao iniciar', async () => {
    useWorkspaceStore.setState({ current: null });
    useMissionSetupStore.setState({
      workspacePath: null,
      draft: {
        objective: '',
        title: '',
        contextPaths: [],
        roster: [],
        advanced: { lane: 'standard' },
        step: 'express',
        revision: 0,
      },
    });
    const host = render(<MissionSetup />);
    await flush();

    const objective = objectiveField(
      host,
      'Seu pedido',
    );
    const acceptance = fieldByLabel<HTMLInputElement>(
      host,
      'Como vou saber que ficou pronto?',
    );
    const reason = host.querySelector<HTMLElement>(
      '#express-draft-disabled-reason',
    );

    expect(button(host, 'Escolher pasta').disabled).toBe(false);
    expect(isObjectiveDisabled(objective)).toBe(false);
    expect(acceptance.disabled).toBe(false);
    // Sem bloqueio de leitura, não há motivo de desabilitação.
    expect(reason).toBeNull();
    expect(host.textContent).toContain(
      'ao iniciar, você escolhe a pasta e o texto acompanha',
    );
    expect(
      button(host, 'Escolher pasta e iniciar').disabled,
    ).toBe(false);

    enterText(objective, 'Quero um sistema de agendamento');
    await flush();
    expect(useMissionSetupStore.getState().draft.objective).toBe(
      'Quero um sistema de agendamento',
    );
    // Nada é persistido sem pasta.
    expect(localStorage.length).toBe(0);
  });

  it('announces a quota failure, keeps the edit in memory, and retries saving', async () => {
    const host = render(<MissionSetup />);
    await flush();
    const storage = withStorageFailure({
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });

    enterText(
      objectiveField(
        host,
        'O que você quer que a equipe entregue?',
      ),
      'Rascunho preservado durante a falha',
    );

    const persistenceStatus = Array.from(
      host.querySelectorAll<HTMLElement>('[role="status"]'),
    ).find((item) => item.textContent?.includes('Rascunho somente na memória'));
    expect(persistenceStatus?.textContent).toContain(
      'O armazenamento local está cheio',
    );
    expect(persistenceStatus?.getAttribute('aria-live')).toBe('polite');
    expect(useMissionSetupStore.getState()).toMatchObject({
      draft: { objective: 'Rascunho preservado durante a falha' },
      persistence: {
        status: 'error',
        operation: 'write',
        reason: 'quota-exceeded',
      },
    });

    storage.restore();
    act(() => button(host, 'Tentar salvar novamente').click());

    expect(useMissionSetupStore.getState().persistence).toEqual({
      status: 'saved',
    });
    expect(host.textContent).not.toContain('Rascunho somente na memória');
    expect(
      JSON.parse(
        localStorage.getItem(missionSetupStorageKey(WORKSPACE.path)) ?? '{}',
      ),
    ).toMatchObject({
      draft: { objective: 'Rascunho preservado durante a falha' },
    });
  });

  it('announces a storage read failure and reloads the saved draft on retry', async () => {
    localStorage.setItem(
      missionSetupStorageKey(WORKSPACE.path),
      JSON.stringify({
        version: 1,
        workspacePath: WORKSPACE.path,
        draft: {
          objective: 'Rascunho salvo antes da falha de leitura',
          title: '',
          contextPaths: [],
          roster: [],
          advanced: { lane: 'standard' },
          step: 'mission',
          revision: 2,
        },
      }),
    );
    const storage = withStorageFailure({
      getItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    // Força a leitura no mount: com workspacePath já igual ao do workspace,
    // setWorkspace seria no-op e a falha de leitura não aconteceria.
    useMissionSetupStore.setState({ workspacePath: null });
    const host = render(<MissionSetup />);
    await flush();

    expect(host.textContent).toContain(
      'Não foi possível ler o rascunho salvo',
    );
    expect(
      isObjectiveDisabled(objectiveField(
        host,
        'Seu pedido',
      )),
    ).toBe(true);

    storage.restore();
    act(() => button(host, 'Tentar ler novamente').click());
    await flush();

    const objective = objectiveField(
      host,
      'O que você quer que a equipe entregue?',
    );
    expect(isObjectiveDisabled(objective)).toBe(false);
    expect(fieldValue(objective)).toBe('Rascunho salvo antes da falha de leitura');
    expect(host.textContent).not.toContain('Rascunho somente na memória');
  });


  it('focuses the persisted-draft read alert or its first recovery action instead of the blocked step', async () => {
    withStorageFailure({
      getItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    useMissionSetupStore.setState({ workspacePath: null });
    const host = render(<MissionSetup />);
    await flush();

    const readAlert = Array.from(
      host.querySelectorAll<HTMLElement>('[role="alert"]'),
    ).find((item) =>
      item.textContent?.includes('Não foi possível ler o rascunho salvo'),
    );
    const retry = button(host, 'Tentar ler novamente');
    const blockedStepHeading =
      host.querySelector<HTMLHeadingElement>('#express-mission-title');
    const objective = objectiveField(
      host,
      'Seu pedido',
    );

    expect(isObjectiveDisabled(objective)).toBe(true);
    expect([readAlert, retry]).toContain(document.activeElement);
    expect(document.activeElement).not.toBe(blockedStepHeading);
  });
  it('discards a corrupt saved draft through the visible recovery action and keeps editing available when replacement storage fails', async () => {
    localStorage.setItem(
      missionSetupStorageKey(WORKSPACE.path),
      '{rascunho-corrompido',
    );
    // Força a leitura no mount (setWorkspace no-op deixaria o rascunho sem ler).
    useMissionSetupStore.setState({ workspacePath: null });
    const host = render(<MissionSetup />);
    await flush();

    const blockedObjective = objectiveField(
      host,
      'Seu pedido',
    );
    expect(host.textContent).toContain('O rascunho salvo está corrompido');
    expect(isObjectiveDisabled(blockedObjective)).toBe(true);

    withStorageFailure({
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });
    act(() =>
      button(host, 'Descartar rascunho salvo e começar vazio').click(),
    );
    await flush();

    const objective = objectiveField(
      host,
      'Seu pedido',
    );
    expect(fieldValue(objective)).toBe('');
    expect(isObjectiveDisabled(objective)).toBe(false);
    expect(host.textContent).not.toContain(
      'O rascunho salvo está corrompido',
    );
    expect(host.textContent).toContain('O armazenamento local está cheio');
    expect(host.textContent).toContain('Rascunho somente na memória');

    enterText(objective, 'Começar uma missão nova depois do descarte');
    await flush();

    expect(fieldValue(objective)).toBe(
      'Começar uma missão nova depois do descarte',
    );
    expect(isObjectiveDisabled(objective)).toBe(false);
    expect(host.textContent).toContain('Rascunho somente na memória');
    expect(button(host, 'Tentar salvar novamente').disabled).toBe(false);
  });

  it('keeps file context root-relative and announces errors before returning focus', async () => {
    const host = render(<MissionSetup />);
    await flush();
    const context = fieldByLabel<HTMLInputElement>(
      host,
      'Adicionar arquivo ou referência',
    );
    const addContext = button(host, 'Adicionar contexto');
    let errorWasCommittedBeforeFocus = false;
    context.addEventListener('focus', () => {
      const error = host.querySelector<HTMLElement>(
        '#mission-new-context-error[role="alert"]',
      );
      errorWasCommittedBeforeFocus =
        error?.textContent?.includes('Use um caminho dentro do projeto') ===
        true;
    });

    enterText(context, '/tmp/segredo.txt');
    act(() => {
      addContext.focus();
      addContext.click();
    });
    const error = host.querySelector<HTMLElement>(
      '#mission-new-context-error[role="alert"]',
    );
    expect(error?.textContent).toContain('Use um caminho dentro do projeto');
    expect(errorWasCommittedBeforeFocus).toBe(true);
    expect(document.activeElement).toBe(context);
    expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([]);

    enterText(context, './src\\App.tsx');
    act(() => addContext.click());
    expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([
      'src/App.tsx',
    ]);
  });

  it('announces an invalid existing context row on Enter without losing focus', async () => {
    const host = render(<MissionSetup />);
    await flush();
    const newContext = fieldByLabel<HTMLInputElement>(
      host,
      'Adicionar arquivo ou referência',
    );
    enterText(newContext, 'src/App.tsx');
    act(() => button(host, 'Adicionar contexto').click());

    const existingContext = fieldByLabel<HTMLInputElement>(
      host,
      'Arquivo ou referência 1',
    );
    act(() => existingContext.focus());
    enterText(existingContext, '../segredo.txt');
    act(() =>
      existingContext.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );

    const errorId = existingContext.getAttribute('aria-describedby');
    const error = errorId ? document.getElementById(errorId) : null;
    expect(error && host.contains(error)).toBe(true);
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('Use um caminho dentro do projeto');
    expect(document.activeElement).toBe(existingContext);
    expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([
      'src/App.tsx',
    ]);
  });

  it('moves focus to the next, previous, then add-context control after removals', async () => {
    const host = render(<MissionSetup />);
    await flush();
    act(() =>
      useMissionSetupStore
        .getState()
        .setContextPaths(['src/a.ts', 'src/b.ts', 'src/c.ts']),
    );

    const removeMiddle = buttonByAriaLabel(host, 'Remover src/b.ts');
    act(() => {
      removeMiddle.focus();
      removeMiddle.click();
    });
    expect(document.activeElement).toBe(
      buttonByAriaLabel(host, 'Remover src/c.ts'),
    );

    const removeLast = buttonByAriaLabel(host, 'Remover src/c.ts');
    act(() => {
      removeLast.focus();
      removeLast.click();
    });
    expect(document.activeElement).toBe(
      buttonByAriaLabel(host, 'Remover src/a.ts'),
    );

    const removeOnly = buttonByAriaLabel(host, 'Remover src/a.ts');
    act(() => {
      removeOnly.focus();
      removeOnly.click();
    });
    expect(document.activeElement).toBe(
      fieldByLabel<HTMLInputElement>(
        host,
        'Adicionar arquivo ou referência',
      ),
    );
  });

  it('keeps inventory degraded when team settings fail and retries before recommending', async () => {
    api.getOrchSettings
      .mockRejectedValueOnce(new Error('settings socket failed'))
      .mockResolvedValueOnce(ORCH_SETTINGS);
    const host = await renderAtTeam();

    expect(host.textContent).toContain(
      'Não foi possível carregar a política da equipe',
    );
    expect(host.textContent).not.toContain('settings socket failed');
    expect(useMissionSetupStore.getState().draft.roster).toEqual([]);

    act(() => button(host, 'Continuar para revisão').click());
    expect(api.prepare).not.toHaveBeenCalled();

    act(() => button(host, 'Tentar carregar equipe').click());
    await flush();
    await flush();

    expect(api.getOrchSettings).toHaveBeenCalledTimes(2);
    expect(useMissionSetupStore.getState().draft.roster.length).toBeGreaterThan(
      0,
    );
    expect(host.textContent).not.toContain(
      'Não foi possível carregar a política da equipe',
    );
  });

  it('preserves a customized saved roster when degraded inventory is retried', async () => {
    const customizedRoster = REVIEW_ROSTER.map((agent, index) => ({
      ...agent,
      agentName:
        index === 1 ? 'Implementar integração personalizada' : agent.agentName,
    }));
    localStorage.setItem(
      missionSetupStorageKey(WORKSPACE.path),
      JSON.stringify({
        version: 1,
        workspacePath: WORKSPACE.path,
        draft: {
          objective: 'Conservar a equipe escolhida',
          title: '',
          contextPaths: [],
          roster: customizedRoster,
          advanced: { lane: 'standard' },
          step: 'team',
          revision: 7,
        },
      }),
    );
    api.getOrchSettings
      .mockRejectedValueOnce(new Error('settings socket failed'))
      .mockResolvedValueOnce(ORCH_SETTINGS);
    // Força a leitura do rascunho salvo (step 'team') no mount.
    useMissionSetupStore.setState({ workspacePath: null });
    const host = render(<MissionSetup />);
    await flush();

    expect(host.textContent).toContain(
      'Implementar integração personalizada',
    );
    expect(host.textContent).toContain(
      'Não foi possível carregar a política da equipe',
    );

    act(() => button(host, 'Tentar carregar equipe').click());
    await flush();
    await flush();

    expect(useMissionSetupStore.getState().draft.roster).toEqual(
      customizedRoster,
    );
    expect(host.textContent).toContain(
      'Implementar integração personalizada',
    );
  });

  it('monta a equipe mesmo com snapshot frio de auth — cache de keychain não esconde coordenador', async () => {
    // Antes, o snapshot frio (login-needed) escondia o coordenador até o warm
    // assíncrono chegar — e a missão nem podia ser montada. Doutrina
    // fluxo-por-padrão: instalada = participa desde o primeiro snapshot.
    const staleClaude: ProviderSettingsInfo = {
      ...provider(CLAUDE),
      authReadyModels: [],
      authStrategy: 'login-needed',
    };
    api.listProviders.mockResolvedValue([staleClaude, provider(CODEX)]);
    const host = await renderAtTeam();

    const coldCoordinator = host.querySelector('[data-category="orchestrator"]');
    expect(coldCoordinator?.getAttribute('data-state')).toBe('ready');

    act(() => {
      useProviderStore.getState().receive(PROVIDERS);
    });
    await flush();

    const coordinator = host.querySelector('[data-category="orchestrator"]');
    expect(coordinator?.getAttribute('data-state')).toBe('ready');
    expect(coordinator?.textContent).toContain('Pronto');
  });


  it.each(MISSION_LANE_GUIDANCE_CASES)(
    'explains $label with concrete PT-BR capabilities as soon as it is selected',
    async ({ lane, label, authority }) => {
      const host = render(<MissionSetup />);
      await flush();
      const advanced = Array.from(host.querySelectorAll('details')).find(
        (item) => item.querySelector('summary')?.textContent === 'Avançado',
      );
      act(() => advanced?.querySelector('summary')?.click());
      const laneField = fieldByLabel<HTMLSelectElement>(
        host,
        'Tipo de trabalho',
      );

      act(() => {
        laneField.value = lane;
        laneField.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();

      const guidanceText = (
        laneField.getAttribute('aria-describedby') ?? ''
      )
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');

      expect(laneField.selectedOptions[0]?.textContent?.trim()).toBe(label);
      for (const statement of authority) {
        expect(guidanceText).toMatch(statement);
      }
    },
  );
  it('progresses through three persistent labels and reveals technical team controls on demand', async () => {
    const host = await renderAtTeam();

    expect(
      host.querySelector('[aria-current="step"]')?.textContent,
    ).toContain('Equipe');
    for (const role of [
      'Coordenar e revisar',
      'Implementar interface',
      'Implementar motor',
      'Verificar o resultado',
    ]) {
      expect(host.textContent).toContain(role);
    }

    const rowDetails = Array.from(host.querySelectorAll('details')).find(
      (item) =>
        item.querySelector('summary')?.textContent?.includes(
          'Configurações técnicas de Coordenar e revisar',
        ),
    );
    expect(rowDetails?.open).toBe(false);
    act(() => rowDetails?.querySelector('summary')?.click());
    expect(rowDetails?.open).toBe(true);
    // Personalização inline (40d35768): Ferramenta/Modelo vivem no cartão,
    // fora do painel técnico, referenciados por aria-label.
    expect(
      (
        host.querySelector(
          'select[aria-label="Ferramenta de IA para Coordenar e revisar"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe('claude');
    // Modelo agora é SELECT com catálogo inteiro (datalist filtrava pelo
    // texto preenchido e parecia catálogo de 2 modelos).
    expect(
      (
        host.querySelector(
          'select[aria-label="Modelo para Coordenar e revisar"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe('sonnet');
  });

  it('adds and removes non-coordinator roles without allowing the coordinator or last worker to disappear', async () => {
    const host = await renderAtTeam();
    const before = useMissionSetupStore.getState().draft.roster;

    act(() => button(host, 'Adicionar implementação').click());
    expect(useMissionSetupStore.getState().draft.roster).toHaveLength(
      before.length + 1,
    );
    expect(
      strictSquadAgentSchema.array().safeParse(
        useMissionSetupStore.getState().draft.roster,
      ).success,
    ).toBe(true);
    expect(
      Array.from(host.querySelectorAll('button')).some((item) =>
        item.getAttribute('aria-label')?.includes('Coordenar e revisar'),
      ),
    ).toBe(false);

    for (const role of [
      'Implementar interface',
      'Implementar motor',
      'Implementar outra parte',
    ]) {
      act(() => button(host, `Remover ${role}`).click());
    }
    const lastWorker = useMissionSetupStore
      .getState()
      .draft.roster.find((agent) => agent.category !== 'orchestrator');
    expect(lastWorker).toBeDefined();
    act(() => button(host, `Remover ${lastWorker!.agentName}`).click());
    expect(host.textContent).toContain('Mantenha ao menos');
    expect(useMissionSetupStore.getState().draft.roster).toHaveLength(2);
  });

  it('omits unsupported effort values from custom roster agents', async () => {
    api.listProviders.mockResolvedValueOnce(
      PROVIDERS.map((item) =>
        item.adapterId === 'codex'
          ? { ...item, effort: '', efforts: [] }
          : item,
      ),
    );
    const host = await renderAtTeam();

    act(() => button(host, 'Adicionar implementação').click());

    const added = useMissionSetupStore
      .getState()
      .draft.roster.find((agent) => agent.agentName === 'Implementar outra parte');
    expect(added).toBeDefined();
    expect(Object.hasOwn(added!, 'effort')).toBe(false);
    expect(JSON.parse(JSON.stringify(added))).toEqual(added);
  });

  it('recommends from the entered objective after fast inventory and refreshes the automatic team for consultation', async () => {
    const adaptersPending = deferred<AdapterInfo[]>();
    const providersPending = deferred<ProviderSettingsInfo[]>();
    const accountsPending = deferred<AccountInfo[]>();
    const settingsPending = deferred<OrchSettings>();
    api.listAdapters.mockReturnValueOnce(adaptersPending.promise);
    api.listProviders.mockReturnValueOnce(providersPending.promise);
    api.listAccounts.mockReturnValueOnce(accountsPending.promise);
    api.getOrchSettings.mockReturnValueOnce(settingsPending.promise);
    api.prepare.mockImplementationOnce(async (request) => ({
      ...REVIEW,
      objective: request.objective,
      roster: request.roster,
    }));

    const host = render(<MissionSetup />);
    await act(async () => {
      adaptersPending.resolve([CLAUDE, CODEX]);
      providersPending.resolve(PROVIDERS);
      accountsPending.resolve(ACCOUNTS);
      settingsPending.resolve(ORCH_SETTINGS);
      await Promise.all([
        adaptersPending.promise,
        providersPending.promise,
        accountsPending.promise,
        settingsPending.promise,
      ]);
    });
    await flush();

    const objective = objectiveField(
      host,
      'O que você quer que a equipe entregue?',
    );
    expect(fieldValue(objective)).toBe('');
    enterText(
      objective,
      'Auditar a interface do cadastro e garantir acessibilidade',
    );
    await flush();
    act(() => button(host, 'Continuar para equipe').click());
    await flush();

    for (const role of [
      'Coordenar e revisar',
      'Implementar interface',
      'Implementar motor',
      'Verificar experiência',
    ]) {
      expect(host.textContent).toContain(role);
    }

    act(() => button(host, 'Voltar para missão').click());
    await flush();
    const advanced = Array.from(host.querySelectorAll('details')).find(
      (item) => item.querySelector('summary')?.textContent === 'Avançado',
    );
    act(() => advanced?.querySelector('summary')?.click());
    const lane = fieldByLabel<HTMLSelectElement>(host, 'Tipo de trabalho');
    act(() => {
      lane.value = 'consult';
      lane.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    act(() => button(host, 'Continuar para equipe').click());
    await flush();

    for (const role of [
      'Coordenar consulta',
      'Auditar interface',
      'Sintetizar recomendações',
    ]) {
      expect(host.textContent).toContain(role);
    }
    expect(host.textContent).not.toContain('Implementar interface');
    expect(host.textContent).not.toContain('Implementar motor');

    act(() => button(host, 'Continuar para revisão').click());
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(
      api.prepare.mock.calls[0]![0].roster.map(
        ({ agentName, allowedTools }) => ({ agentName, allowedTools }),
      ),
    ).toEqual([
      // Sem teto de lane: papéis recomendados chegam irrestritos (null).
      {
        agentName: 'Coordenar consulta',
        allowedTools: null,
      },
      {
        agentName: 'Auditar interface',
        allowedTools: null,
      },
      {
        agentName: 'Sintetizar recomendações',
        allowedTools: null,
      },
    ]);
    for (const role of [
      'Coordenar consulta',
      'Auditar interface',
      'Sintetizar recomendações',
    ]) {
      expect(host.textContent).toContain(role);
    }
  });

  it('preserves a customized team across an authority change until recommendation refresh is explicit', async () => {
    const host = await renderAtTeam();
    const coordinatorDetails = Array.from(
      host.querySelectorAll('details'),
    ).find((item) =>
      item
        .querySelector('summary')
        ?.textContent?.includes(
          'Configurações técnicas de Coordenar e revisar',
        ),
    );
    act(() => coordinatorDetails?.querySelector('summary')?.click());
    enterText(
      fieldByLabel<HTMLInputElement>(host, 'Papel na equipe'),
      'Liderar investigação personalizada',
    );
    await flush();
    expect(host.textContent).toContain(
      'Liderar investigação personalizada',
    );

    act(() => button(host, 'Voltar para missão').click());
    await flush();
    const advanced = Array.from(host.querySelectorAll('details')).find(
      (item) => item.querySelector('summary')?.textContent === 'Avançado',
    );
    act(() => advanced?.querySelector('summary')?.click());
    const lane = fieldByLabel<HTMLSelectElement>(host, 'Tipo de trabalho');
    act(() => {
      lane.value = 'consult';
      lane.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    act(() => button(host, 'Continuar para equipe').click());
    await flush();

    expect(host.textContent).toContain(
      'Liderar investigação personalizada',
    );
    expect(host.textContent).toContain('Implementar interface');
    expect(host.textContent).toContain(
      'A equipe não corresponde mais ao tipo de trabalho',
    );

    act(() => button(host, 'Atualizar recomendação').click());
    await flush();

    expect(host.textContent).not.toContain(
      'Liderar investigação personalizada',
    );
    expect(host.textContent).not.toContain('Implementar interface');
    expect(host.textContent).not.toContain(
      'A equipe não corresponde mais ao tipo de trabalho',
    );
    for (const role of [
      'Coordenar consulta',
      'Mapear solução',
      'Sintetizar recomendações',
    ]) {
      expect(host.textContent).toContain(role);
    }
  });

  it('passes a customized standard roster through unchanged when the lane changes before prepare', async () => {
    const customCodex = adapter('codex', {
      models: {
        list: ['gpt-5.6-sol', 'gpt-enterprise'],
        default: 'gpt-5.6-sol',
      },
    });
    api.listAdapters.mockResolvedValueOnce([CLAUDE, customCodex]);
    api.listProviders.mockResolvedValueOnce([
      provider(CLAUDE),
      provider(customCodex),
    ]);
    const customizedRoster = REVIEW_ROSTER.map((agent) =>
      agent.id === 'interface-executor'
        ? {
            ...agent,
            agentName: 'Especialista da integração',
            providerId: 'codex-subscription',
            model: 'gpt-enterprise',
            instructions:
              'Inspecione o contrato de pagamentos sem modificá-lo.',
            allowedSkills: ['react-best-practices'],
          }
        : agent,
    );
    useMissionSetupStore.setState({
      workspacePath: WORKSPACE.path,
      draft: {
        objective: 'Investigar a integração sem alterar arquivos',
        title: '',
        contextPaths: [],
        roster: customizedRoster,
        advanced: { lane: 'standard' },
        step: 'mission',
        revision: 9,
      },
      persistence: { status: 'idle' },
      workspaceDrafts: {},
    });
    const host = render(<MissionSetup />);
    await flush();

    const lane = fieldByLabel<HTMLSelectElement>(host, 'Tipo de trabalho');
    act(() => {
      lane.value = 'consult';
      lane.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    act(() => button(host, 'Continuar para equipe').click());
    await flush();
    act(() => button(host, 'Continuar para revisão').click());
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(1);
    const prepared = api.prepare.mock.calls[0]![0];
    expect(prepared.advanced).toEqual({ lane: 'consult' });
    // Sem teto de lane, trocar para 'consult' não altera os grants: eles
    // passam adiante como declarados no roster customizado.
    expect(
      prepared.roster.map(({ id, allowedTools }) => ({ id, allowedTools })),
    ).toEqual([
      { id: 'mission-coordinator', allowedTools: null },
      { id: 'interface-executor', allowedTools: ['Bash', 'Read', 'Edit'] },
      { id: 'engine-executor', allowedTools: ['Bash', 'Read', 'Edit'] },
      { id: 'result-reviewer', allowedTools: ['Bash', 'Read'] },
    ]);
    expect(prepared.roster[1]).toMatchObject({
      id: 'interface-executor',
      agentName: 'Especialista da integração',
      category: 'executor',
      cli: 'codex',
      providerId: 'codex-subscription',
      model: 'gpt-enterprise',
      effort: 'high',
      instructions: 'Inspecione o contrato de pagamentos sem modificá-lo.',
      allowedSkills: ['react-best-practices'],
      allowedTools: ['Bash', 'Read', 'Edit'],
    });
    expect(useMissionSetupStore.getState().draft.roster).toEqual(
      prepared.roster,
    );
  });

  it('prepares exactly once on entering Review and never starts before the exact review is visible', async () => {
    const pendingReview = deferred<MissionReview>();
    api.prepare.mockReturnValueOnce(pendingReview.promise);
    const host = await renderAtTeam();
    const next = button(host, 'Continuar para revisão');

    act(() => {
      next.click();
      next.click();
    });
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledWith({
      objective: 'Criar um fluxo simples de missão',
      contextPaths: [],
      roster: expect.arrayContaining([
        expect.objectContaining({
          id: 'mission-coordinator',
          category: 'orchestrator',
        }),
      ]),
      advanced: { lane: 'standard' },
    });
    expect(Object.keys(api.prepare.mock.calls[0]![0])).toEqual([
      'objective',
      'contextPaths',
      'roster',
      'advanced',
    ]);
    expect(api.start).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Preparando a revisão segura');
    expect(button(host, 'Iniciar missão').disabled).toBe(true);

    await act(async () => {
      pendingReview.resolve(REVIEW);
      await pendingReview.promise;
    });
    expect(host.textContent).toContain(REVIEW.objective);
    expect(
      host.querySelector('[aria-current="step"]')?.textContent,
    ).toContain('Revisar');
    expect(button(host, 'Iniciar missão').disabled).toBe(false);
  });

  it('renders the main-owned review and starts only its visible exact hash before opening its board', async () => {
    const pendingStart = deferred<MissionSnapshot>();
    api.start.mockReturnValueOnce(pendingStart.promise);
    const host = await renderAtReview();

    expect(host.textContent).toContain(REVIEW.objective);
    expect(host.textContent).toContain(REVIEW.workspaceLabel);
    expect(host.textContent).toContain(REVIEW.contextPaths[0]);
    expect(host.textContent).toContain(REVIEW.permissions[0]!.label);
    expect(host.textContent).toContain(REVIEW.warnings[0]);
    expect(host.textContent).not.toContain('Criar um fluxo simples de missão');

    const advanced = Array.from(host.querySelectorAll('details')).find(
      (item) => item.querySelector('summary')?.textContent === 'Avançado',
    );
    act(() => advanced?.querySelector('summary')?.click());
    expect(host.textContent).toContain(REVIEW.reviewSha256);
    expect(
      Array.from(host.querySelectorAll('button')).filter(
        (item) => item.textContent?.trim() === 'Iniciar missão',
      ),
    ).toHaveLength(1);

    const start = button(host, 'Iniciar missão');
    act(() => {
      start.click();
      start.click();
    });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledWith({
      missionId: REVIEW.missionId,
      reviewSha256: REVIEW.reviewSha256,
    });

    await act(async () => {
      pendingStart.resolve(SNAPSHOT);
      await pendingStart.promise;
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: SNAPSHOT.id,
      surface: 'board',
    });
  });

  it.each([
    {
      change: 'objetivo',
      mutate: () =>
        useMissionSetupStore.getState().setObjective('Objetivo alterado'),
    },
    {
      change: 'contexto',
      mutate: () =>
        useMissionSetupStore
          .getState()
          .setContextPaths(['docs/novo-contexto.md']),
    },
    {
      change: 'equipe',
      mutate: () =>
        useMissionSetupStore.getState().setRoster(REVIEW_ROSTER.slice(0, 3)),
    },
    {
      change: 'configuração avançada',
      mutate: () => useMissionSetupStore.getState().setAdvancedLane('consult'),
    },
  ])('invalidates a visible review after changing $change', async ({ mutate }) => {
    const host = await renderAtReview();
    const staleStart = button(host, 'Iniciar missão');
    expect(host.textContent).toContain(REVIEW.objective);

    act(() => {
      mutate();
      staleStart.click();
    });
    await flush();

    expect(host.textContent).not.toContain(REVIEW.objective);
    expect(api.start).not.toHaveBeenCalled();
    expect(
      host.querySelector('[aria-current="step"]')?.textContent,
    ).toContain('Equipe');
  });

  it('invalidates the visible review before a stale start after a workspace change', async () => {
    const host = await renderAtReview();
    const staleStart = button(host, 'Iniciar missão');

    act(() => {
      useWorkspaceStore.setState({ current: OTHER_WORKSPACE });
      staleStart.click();
    });
    await flush();

    expect(api.start).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(REVIEW.objective);
    expect(useMissionSetupStore.getState().workspacePath).toBe(
      OTHER_WORKSPACE.path,
    );
  });

  it('invalidates review and discards its stale prepare result after a workspace change', async () => {
    const pendingReview = deferred<MissionReview>();
    api.prepare.mockReturnValueOnce(pendingReview.promise);
    const host = await renderAtTeam();
    act(() => button(host, 'Continuar para revisão').click());
    await flush();

    act(() => {
      useWorkspaceStore.setState({ current: OTHER_WORKSPACE });
    });
    await flush();
    await act(async () => {
      pendingReview.resolve(REVIEW);
      await pendingReview.promise;
    });

    expect(host.textContent).not.toContain(REVIEW.objective);
    expect(useMissionSetupStore.getState().workspacePath).toBe(
      OTHER_WORKSPACE.path,
    );
    expect(api.start).not.toHaveBeenCalled();
  });

  it('discards a pending review when the captured draft revision changes', async () => {
    const pendingReview = deferred<MissionReview>();
    api.prepare.mockReturnValueOnce(pendingReview.promise);
    const host = await renderAtTeam();
    act(() => button(host, 'Continuar para revisão').click());
    await flush();

    act(() =>
      useMissionSetupStore
        .getState()
        .setContextPaths(['docs/revisao-alterada.md']),
    );
    await flush();
    await act(async () => {
      pendingReview.resolve(REVIEW);
      await pendingReview.promise;
    });

    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain(REVIEW.objective);
    expect(
      host.querySelector('[aria-current=\"step\"]')?.textContent,
    ).toContain('Equipe');
    expect(api.start).not.toHaveBeenCalled();
  });

  it('preserves the draft and offers another prepare after a prepare failure', async () => {
    api.prepare
      .mockRejectedValueOnce(new Error('prepare socket failed'))
      .mockResolvedValueOnce(REVIEW);
    const host = await renderAtTeam();
    act(() => button(host, 'Continuar para revisão').click());
    await flush();

    expect(host.textContent).toContain(
      'Não foi possível preparar a revisão',
    );
    expect(host.textContent).not.toContain('prepare socket failed');
    expect(useMissionSetupStore.getState().draft.objective).toBe(
      'Criar um fluxo simples de missão',
    );

    act(() => button(host, 'Preparar nova revisão').click());
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(REVIEW.objective);
  });

  it('descarta uma revisão desatualizada e exige uma nova revisão exata antes de reiniciar', async () => {
    const refreshedReview: MissionReview = {
      ...REVIEW,
      missionId: 'mission-refreshed',
      objective: 'Entrega atualizada por uma nova revisão principal',
      reviewSha256: 'b'.repeat(64),
      createdAt: REVIEW.createdAt + 1,
    };
    api.prepare
      .mockResolvedValueOnce(REVIEW)
      .mockResolvedValueOnce(refreshedReview);
    api.start
      .mockRejectedValueOnce(new Error('review fence mismatch'))
      .mockResolvedValueOnce(SNAPSHOT);
    const host = await renderAtReview();
    const staleStart = button(host, 'Iniciar missão');

    act(() => staleStart.click());
    await flush();

    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenNthCalledWith(1, {
      missionId: REVIEW.missionId,
      reviewSha256: REVIEW.reviewSha256,
    });
    expect(api.removeMission).toHaveBeenCalledWith(REVIEW.missionId);
    expect(host.textContent).not.toContain(REVIEW.objective);
    expect(host.textContent).toContain(
      'A revisão pode ter ficado desatualizada e foi descartada',
    );
    expect(host.textContent).not.toContain('review fence mismatch');
    expect(button(host, 'Iniciar missão').disabled).toBe(true);

    act(() => staleStart.click());
    expect(api.start).toHaveBeenCalledTimes(1);

    act(() => button(host, 'Preparar nova revisão').click());
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(refreshedReview.objective);
    expect(button(host, 'Iniciar missão').disabled).toBe(false);

    act(() => button(host, 'Iniciar missão').click());
    await flush();

    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start).toHaveBeenNthCalledWith(2, {
      missionId: refreshedReview.missionId,
      reviewSha256: refreshedReview.reviewSha256,
    });
  });

  it('preserva a missão e mostra o diagnóstico real quando o kickoff falha', async () => {
    api.prepare.mockResolvedValueOnce(REVIEW);
    api.start.mockRejectedValueOnce(
      new Error(
        'kickoff-session_exited: O terminal encerrou antes de aceitar o kickoff.',
      ),
    );
    const host = await renderAtReview();

    act(() => button(host, 'Iniciar missão').click());
    await flush();

    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.removeMission).not.toHaveBeenCalledWith(REVIEW.missionId);
    expect(host.textContent).toContain(
      'O coordenador encerrou antes de aceitar o início',
    );
    expect(host.textContent).not.toContain(
      'A revisão pode ter ficado desatualizada e foi descartada',
    );
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: REVIEW.missionId,
      surface: 'board',
    });
  });


  it('uses native names, focusable status, and plain PT-BR without legacy wizard jargon', async () => {
    const host = render(<MissionSetup />);
    await flush();

    expect(host.querySelector('nav[aria-label="Etapas da missão"]')).not.toBeNull();
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(
      objectiveField(
        host,
        'O que você quer que a equipe entregue?',
      ).getAttribute('aria-describedby'),
    ).toBeTruthy();
    expect(button(host, 'Escolher pasta').type).toBe('button');
    expect(button(host, 'Continuar para equipe').type).toBe('button');
    expect(host.textContent).not.toMatch(
      /\b(?:PRD|Autopilot|Squad|Maestro|worker|receipt)\b/i,
    );
  });
});

describe('Caminho Expresso', () => {
  /** Monta o MissionSetup já na tela Expresso, com pasta ativa e inventário ok. */
  async function renderAtExpress(): Promise<HTMLElement> {
    useMissionSetupStore.setState({
      workspacePath: WORKSPACE.path,
      draft: {
        objective: '',
        title: '',
        contextPaths: [],
        roster: [],
        advanced: { lane: 'standard' },
        step: 'express',
        revision: 0,
      },
      persistence: { status: 'idle' },
      workspaceDrafts: {},
    });
    const host = render(<MissionSetup />);
    await flush();
    return host;
  }

  it('abre direto no Expresso (sem wizard) com a pasta e o objetivo habilitados', async () => {
    const host = await renderAtExpress();

    expect(host.textContent).toContain('O que você quer criar?');
    expect(
      host.querySelector('nav[aria-label="Etapas da missão"]'),
    ).toBeNull();
    expect(host.querySelector('[aria-current="step"]')).toBeNull();
    const project = host.querySelector<HTMLElement>('#express-workspace-name');
    expect(project?.textContent).toBe(WORKSPACE.name);
    expect(project?.title).toBe(WORKSPACE.path);
    expect(button(host, 'Trocar pasta').type).toBe('button');
    const objective = objectiveField(
      host,
      'Seu pedido',
    );
    expect(fieldValue(objective)).toBe('');
    expect(isObjectiveDisabled(objective)).toBe(false);
    expect(button(host, 'Iniciar criação').type).toBe('submit');
    expect(button(host, 'Mais papéis e tamanho').type).toBe('button');
    expect(button(host, 'Ditar objetivo').type).toBe('button');
    await flush();
    await flush();
    expect(host.textContent).toContain('Quem faz o quê');
    const team = host.querySelector<HTMLDetailsElement>('#express-team-options');
    expect(team).not.toBeNull();
    expect(team!.open).toBe(false);
    expect(team!.querySelector('summary')?.textContent)
      .toContain('Personalizar equipe');
    expect(
      host.querySelectorAll('select[aria-label^="Ferramenta de IA"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(host.textContent).toContain('Anexos do cliente');
    expect(
      host.querySelector('input[type="file"][accept*="audio"]'),
    ).not.toBeNull();
  });

  it('oferece o caminho manual na própria tela, sem mandar o operador a Terminais', async () => {
    const host = await renderAtExpress();

    // A capacidade existia no Launcher antigo e foi perdida: sem esta seção o
    // operador tem que sair para Terminais só para achar um terminal.
    expect(host.textContent).toContain('Prefere trabalhar nos terminais?');
    expect(button(host, 'Montar meus terminais').type).toBe('button');
    expect(button(host, 'Terminal sem IA').type).toBe('button');

    // Secundários: nunca competem com o CTA primário da tela.
    for (const label of ['Montar meus terminais', 'Terminal sem IA']) {
      expect(button(host, label).className).toContain('action-card--ghost');
    }
    expect(button(host, 'Iniciar criação').className).toContain(
      'mission-setup__button--primary',
    );
  });

  it('atalhos 1–6 disparam na tela real de início, não só no Launcher órfão', async () => {
    const host = render(<MissionSetup home />);
    await flush();

    expect(
      host.querySelector('[data-launcher-action="pane"] kbd')?.textContent,
    ).toBe('1');
    expect(
      host.querySelector('[data-launcher-action="tasks"] kbd')?.textContent,
    ).toBe('5');
    expect(
      host.querySelector('[data-launcher-action="mission"]')?.textContent,
    ).toBe('2');
    expect(
      host.querySelector('[data-launcher-action="workspace"] kbd')?.textContent,
    ).toBe('3');

    const objective = objectiveField(host, 'Seu pedido');
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(objective);
    act(() => objective.blur());

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', bubbles: true }),
      );
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'task-board',
    });

    useProductNavigationStore.setState({
      destination: { kind: 'mission-setup' },
    });
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', bubbles: true, metaKey: true }),
      );
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });

    act(() => {
      objective.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', bubbles: true }),
      );
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });

    await flush();
    await flush();
    const tool = host.querySelector<HTMLSelectElement>(
      'select[aria-label^="Ferramenta de IA"]',
    );
    expect(tool).not.toBeNull();
    act(() => {
      tool!.focus();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', bubbles: true }),
      );
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
  });

  it('atalho 3 não troca a pasta enquanto a criação está em andamento', async () => {
    const pick = vi.fn(async () => undefined);
    useWorkspaceStore.setState({ pick });
    useProductNavigationStore.setState({ destination: { kind: 'launcher' } });
    const host = render(<MissionSetup home />);
    await flush();
    await flush();
    enterText(
      objectiveField(host, 'Seu pedido'),
      'Crie uma página de contato',
    );

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '3', bubbles: true }),
      );
    });
    expect(pick).toHaveBeenCalledTimes(1);

    pick.mockClear();
    const pendingReview = deferred<MissionReview>();
    api.prepare.mockReturnValueOnce(pendingReview.promise);
    act(() => button(host, 'Iniciar criação').click());
    await flush();
    await flush();
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(button(host, 'Trocar pasta').disabled).toBe(true);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '3', bubbles: true }),
      );
    });
    expect(pick).not.toHaveBeenCalled();
    pendingReview.resolve(REVIEW);
    await flush();
  });

  it('F-1174: leitor de tela ouve a lista de atalhos do início (as teclas visíveis são aria-hidden)', async () => {
    const host = render(<MissionSetup home />);
    await flush();
    const announced = host.querySelector('#mission-setup-shortcuts');
    expect(announced?.classList.contains('mission-setup__sr-only')).toBe(true);
    expect(announced?.textContent).toBe(
      'Atalhos do teclado: 1 Montar meus terminais; 2 Criar com IA; 3 Abrir projeto existente; ' +
        '4 Terminal sem IA; 5 Quadro de tarefas; 6 Memória do projeto',
    );
    expect(host.querySelector('[data-launcher-action="pane"] kbd')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('atalhos do início não disparam no assistente avançado', async () => {
    const host = render(<MissionSetup />);
    await flush();
    expect(host.querySelector('[data-launcher-action="tasks"]')).toBeNull();
    expect(host.querySelector('#mission-setup-shortcuts')).toBeNull();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '5', bubbles: true }),
      );
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
  });

  it('abrir e recolher opções preserva o rascunho e inicia a equipe selecionada', async () => {
    const host = await renderAtExpress();
    enterText(
      objectiveField(host, 'Seu pedido'),
      'Crie uma página de contato',
    );
    await flush();
    const before = useMissionSetupStore.getState().draft;
    const team = host.querySelector<HTMLDetailsElement>('#express-team-options');
    expect(team).not.toBeNull();
    const toggle = team!.querySelector('summary')!;

    act(() => toggle.click());
    expect(team!.open).toBe(true);
    act(() => toggle.click());
    expect(team!.open).toBe(false);
    expect(useMissionSetupStore.getState().draft).toEqual(before);

    act(() => button(host, 'Iniciar criação').click());
    await flush();
    expect(api.prepare.mock.calls[0]![0].roster).toEqual(before.roster);
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it('detalhes opcionais ficam antes de iniciar e preservam critérios no pedido', async () => {
    const host = await renderAtExpress();
    const details = host.querySelector<HTMLDetailsElement>(
      '#express-delivery-details',
    );
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(
      details!.compareDocumentPosition(button(host, 'Iniciar criação')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => details!.querySelector('summary')!.click());
    enterText(
      objectiveField(host, 'Seu pedido'),
      'Crie uma página de contato',
    );
    enterText(
      fieldByLabel<HTMLInputElement>(host, 'Como vou saber que ficou pronto?'),
      'O formulário funciona no celular.',
    );

    act(() => button(host, 'Iniciar criação').click());
    await flush();
    expect(api.prepare.mock.calls[0]![0].acceptanceCriteria)
      .toEqual(['O formulário funciona no celular.']);
  });

  it('anexa áudio de fora do projeto como contexto relativo da missão', async () => {
    const finishImports = observeAttachmentWork();
    const host = await renderAtExpress();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const audio = new File(['bytes'], 'cliente.m4a', { type: 'audio/mp4' });
    Object.defineProperty(input, 'files', { configurable: true, value: [audio] });
    act(() => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await finishImports();

    expect(api.importMissionAttachment).toHaveBeenCalledTimes(1);
    expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([
      '.nexus/attachments/mission-context/token-cliente.m4a',
    ]);
    expect(host.textContent).toContain('cliente.m4a');
  });

  it('não duplica imagem colada enquanto o mesmo arquivo ainda está importando', async () => {
    const finishImports = observeAttachmentWork();
    const pendingImport = deferred<{ ok: true; path: string }>();
    api.importMissionAttachment.mockImplementationOnce(
      async () => pendingImport.promise,
    );
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();
    const image = new File(['bytes'], 'print.png', {
      type: 'image/png',
      lastModified: 10,
    });
    const clipboardData = {
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => image,
        },
      ],
      files: [image],
    };

    act(() => {
      dropZone!.dispatchEvent(
        Object.assign(new Event('paste', { bubbles: true }), {
          clipboardData,
        }),
      );
      dropZone!.dispatchEvent(
        Object.assign(new Event('paste', { bubbles: true }), {
          clipboardData,
        }),
      );
    });
    try {
      await act(async () => {
        await vi.waitFor(() => {
          expect(api.importMissionAttachment).toHaveBeenCalledTimes(1);
        });
      });
    } finally {
      pendingImport.resolve({
        ok: true,
        path: '.nexus/attachments/mission-context/token-print.png',
      });
      await finishImports();
    }

    expect(api.importMissionAttachment).toHaveBeenCalledTimes(1);
    expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([
      '.nexus/attachments/mission-context/token-print.png',
    ]);
    expect(host.textContent).toContain('print.png');
  });

  it('não duplica a mesma imagem colada duas vezes depois do import terminar', async () => {
    const finishImports = observeAttachmentWork();
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();
    const image = new File(['same-png-bytes'], 'image.png', {
      type: 'image/png',
      lastModified: 10,
    });
    const clipboardData = {
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => image,
        },
      ],
      files: [image],
    };

    act(() => {
      dropZone!.dispatchEvent(
        Object.assign(new Event('paste', { bubbles: true }), {
          clipboardData,
        }),
      );
    });
    await finishImports();
    await vi.waitFor(async () => {
      await flush();
      expect(useMissionSetupStore.getState().draft.contextPaths).toHaveLength(1);
      expect(button(host, 'Anexar arquivo').disabled).toBe(false);
    });
    act(() => {
      dropZone!.dispatchEvent(
        Object.assign(new Event('paste', { bubbles: true }), {
          clipboardData,
        }),
      );
      window.dispatchEvent(
        Object.assign(new Event('paste', { bubbles: true }), {
          clipboardData,
        }),
      );
    });
    await finishImports();

    expect(api.importMissionAttachment).toHaveBeenCalledTimes(1);
    expect(useMissionSetupStore.getState().draft.contextPaths).toHaveLength(1);
    expect(
      host.querySelectorAll('.mission-attachment-picker__list li'),
    ).toHaveLength(1);
  });

  it('drop no drop-zone sem File usa o endereço da promessa de arquivo', async () => {
    // WhatsApp/Fotos entregam a PROMESSA; `files` vem vazia mas o uri-list vem.
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();
    const uri = 'file:///Users/ana/foto.png';

    await act(async () => {
      dropZone!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
          dataTransfer: {
            types: ['Files', 'text/uri-list'],
            files: [],
            getData: (type: string) => (type === 'text/uri-list' ? uri : ''),
          },
        }),
      );
    });
    await vi.waitFor(async () => {
      await flush();
      expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([
        '.nexus/attachments/mission-context/token-foto.png',
      ]);
    });

    expect(api.importDroppedUri).toHaveBeenCalledWith(uri);
    expect(api.importMissionAttachment).not.toHaveBeenCalled();
  });

  it('drop no drop-zone sem nada aproveitável mostra o motivo em vez de silêncio', async () => {
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();

    act(() => {
      dropZone!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
          dataTransfer: { types: ['Files'], files: [], getData: () => '' },
        }),
      );
    });

    const error = host.querySelector('.mission-setup__inline-error');
    expect(error?.textContent).toContain('Finder');
    expect(api.importDroppedUri).not.toHaveBeenCalled();
  });

  it('colar arquivo dentro do drop-zone não chega ao shell; colar texto passa', async () => {
    // O App agora é o dono único do paste no window; a zona precisa segurar
    // a cola de arquivo para o shell não importar em dobro.
    const finishImports = observeAttachmentWork();
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();
    const seenByWindow: string[] = [];
    const spy = (event: Event) => {
      const data = (event as ClipboardEvent).clipboardData;
      seenByWindow.push(data && data.files.length > 0 ? 'file' : 'text');
    };
    window.addEventListener('paste', spy);
    try {
      const image = new File(['bytes'], 'print.png', { type: 'image/png' });
      act(() => {
        dropZone!.dispatchEvent(
          Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
            clipboardData: {
              items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
              files: [image],
            },
          }),
        );
        dropZone!.dispatchEvent(
          Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
            clipboardData: { items: [], files: [] },
          }),
        );
      });
    } finally {
      window.removeEventListener('paste', spy);
    }
    // A cola com arquivo dispara um import real; sem esperar, ele terminava
    // durante o teste seguinte e enfiava print.png no rascunho alheio.
    await finishImports();

    // Só a cola SEM arquivo atravessa a zona.
    expect(seenByWindow).toEqual(['text']);
  });

  it('drop na zona desabilitada não é engolido: o evento segue para o shell', () => {
    // `disabled` vem do pai (rascunho travado / missão iniciando). Antes o
    // picker fazia preventDefault + stopPropagation ANTES de olhar `disabled`,
    // e o drop morria ali: nem a zona anexava, nem o shell ficava sabendo.
    const host = render(
      <MissionAttachmentPicker
        contextPaths={[]}
        disabled
        onContextPathsChange={() => undefined}
      />,
    );
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();
    const seenByWindow = vi.fn();
    window.addEventListener('drop', seenByWindow);
    try {
      const event = Object.assign(
        new Event('drop', { bubbles: true, cancelable: true }),
        {
          dataTransfer: {
            types: ['Files'],
            files: [new File(['b'], 'b.png', { type: 'image/png' })],
            getData: () => '',
          },
        },
      );
      act(() => {
        dropZone!.dispatchEvent(event);
      });
      expect(seenByWindow).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(false);
      expect(api.importMissionAttachment).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('drop', seenByWindow);
    }
  });

  it('soltar sem arquivo no drop zone anexa pelo endereço em vez de silenciar', async () => {
    // Arrastar mídia de um app nativo (WhatsApp) traz a PROMESSA do arquivo, não
    // o arquivo: `dataTransfer.files` vem vazia. A zona caía em
    // `filesFromClipboardData`, que devolve [] por construção — silêncio puro.
    const finishImports = observeAttachmentWork();
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();

    await act(async () => {
      dropZone!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
          dataTransfer: {
            types: ['Files', 'text/uri-list'],
            files: [],
            getData: (type: string) =>
              type === 'text/uri-list' ? 'file:///Users/ana/cliente.png' : '',
          },
        }),
      );
    });
    await finishImports();

    expect(api.importDroppedUri).toHaveBeenCalledWith(
      'file:///Users/ana/cliente.png',
    );
    // Asserção por presença, não por contagem: o store do wizard é
    // módulo-level e outros testes do arquivo disparam imports assíncronos sem
    // aguardá-los, que aterrissam neste rascunho depois. O que este teste prova
    // é que o ENDEREÇO virou anexo — antes da correção `importDroppedUri` nem
    // era chamado e a lista ficava vazia.
    expect(useMissionSetupStore.getState().draft.contextPaths).toContain(
      '.nexus/attachments/mission-context/token-cliente.png',
    );
    expect(host.textContent).toContain('cliente.png');
  });

  it('soltar no drop zone algo inaproveitável mostra o motivo, não silêncio', async () => {
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();

    await act(async () => {
      dropZone!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
          dataTransfer: { types: ['Files'], files: [], getData: () => '' },
        }),
      );
    });

    expect(
      host.querySelector('.mission-setup__inline-error')?.textContent,
    ).toMatch(/Finder/);
  });

  it('colar dentro da zona de anexos não vaza para o shell', async () => {
    // Quem é dono da cola na zona é o picker (com os erros inline dele e a
    // deduplicação por content-key). Se o evento subisse até o window, o intake
    // do shell importaria a MESMA imagem uma segunda vez.
    const finishImports = observeAttachmentWork();
    const host = await renderAtExpress();
    const dropZone = host.querySelector<HTMLElement>(
      '.mission-attachment-picker__drop',
    );
    expect(dropZone).not.toBeNull();

    const shellSaw: Event[] = [];
    const onWindowPaste = (event: Event) => {
      shellSaw.push(event);
    };
    window.addEventListener('paste', onWindowPaste);
    try {
      const image = new File(['bytes'], 'image.png', { type: 'image/png' });
      const clipboardData = {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        files: [image],
      };
      await act(async () => {
        dropZone!.dispatchEvent(
          Object.assign(
            new Event('paste', { bubbles: true, cancelable: true }),
            { clipboardData },
          ),
        );
      });
      await finishImports();
    } finally {
      window.removeEventListener('paste', onWindowPaste);
    }

    expect(shellSaw).toHaveLength(0);
    expect(api.importMissionAttachment).toHaveBeenCalledTimes(1);
  });

  it('mostra anexos do cliente no wizard avançado e importa áudio externo', async () => {
    const finishImports = observeAttachmentWork();
    const host = render(<MissionSetup />);
    await flush();

    expect(host.textContent).toContain('Anexos do cliente');
    expect(
      host.querySelector('input[type="file"][accept*="audio"]'),
    ).not.toBeNull();

    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const audio = new File(['bytes'], 'cliente.m4a', { type: 'audio/mp4' });
    Object.defineProperty(input, 'files', { configurable: true, value: [audio] });
    act(() => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await finishImports();

    expect(api.importMissionAttachment).toHaveBeenCalledTimes(1);
    expect(useMissionSetupStore.getState().draft.contextPaths).toEqual([
      '.nexus/attachments/mission-context/token-cliente.m4a',
    ]);
    expect(host.textContent).toContain('cliente.m4a');
    expect(host.textContent).not.toContain(
      '.nexus/attachments/mission-context/token-cliente.m4a',
    );
  });

  it('Iniciar missão recomenda a equipe e chama prepare+start com modo livre selado', async () => {
    const host = await renderAtExpress();
    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'Construir uma landing page com formulário de contato',
    );
    await flush();
    await flush();
    expect(host.textContent).toContain('Quem faz o quê');
    expect(
      host.querySelector('[aria-label="Quem faz o quê"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('select[aria-label^="Ferramenta de IA"]'),
    ).not.toBeNull();

    act(() => button(host, 'Iniciar criação').click());
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(1);
    const prepared = api.prepare.mock.calls[0]![0];
    expect(prepared.advanced).toEqual({
      lane: 'standard',
      freeAgentChoice: true,
    });
    expect(
      prepared.roster.some((agent) => agent.category === 'orchestrator'),
    ).toBe(true);
    expect(
      prepared.roster.some((agent) => agent.category === 'executor'),
    ).toBe(true);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledWith({
      missionId: REVIEW.missionId,
      reviewSha256: REVIEW.reviewSha256,
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: SNAPSHOT.id,
      surface: 'board',
    });
  });

  it('Iniciar missão também funciona pela submissão nativa do formulário', async () => {
    const host = await renderAtExpress();
    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'Construir uma página de contato com formulário funcionando',
    );
    await flush();
    await flush();

    const form = host.querySelector<HTMLFormElement>(
      '.mission-setup__step--express',
    );
    expect(form).not.toBeNull();

    act(() => {
      form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it('Iniciar missão despacha o AGY escolhido pelo operador em cada papel', async () => {
    const agy = adapter('agy', {
      label: 'Antigravity',
      models: { list: ['gemini-2.5-pro'], default: 'gemini-2.5-pro' },
      orchestratorCapable: false,
      missionControlCapable: false,
    });
    api.listAdapters.mockResolvedValue([CLAUDE, CODEX, agy]);
    api.listProviders.mockResolvedValue([
      provider(CLAUDE),
      provider(CODEX),
      provider(agy),
    ]);

    const host = await renderAtExpress();
    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'Construir uma landing page com formulário de contato',
    );
    await flush();
    await flush();

    const team = host.querySelector<HTMLDetailsElement>('#express-team-options')!;
    act(() => team.querySelector('summary')!.click());
    const tool = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Ferramenta de IA para Implementar interface"]',
    );
    expect(tool).not.toBeNull();
    expect([...tool!.options].map((option) => option.value)).toEqual(
      expect.arrayContaining(['codex', 'agy']),
    );

    act(() => {
      tool!.value = 'agy';
      tool!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(
      useMissionSetupStore
        .getState()
        .draft.roster.find((agent) => agent.agentName === 'Implementar interface')
        ?.cli,
    ).toBe('agy');
    const selectedRoster = useMissionSetupStore.getState().draft.roster;
    act(() => team.querySelector('summary')!.click());
    expect(team.open).toBe(false);

    act(() => button(host, 'Iniciar criação').click());
    await flush();
    await flush();

    expect(api.prepare).toHaveBeenCalledTimes(1);
    const prepared = api.prepare.mock.calls[0]![0];
    expect(prepared.roster).toEqual(selectedRoster);
    expect(
      prepared.roster.find((agent) => agent.agentName === 'Implementar interface')
        ?.cli,
    ).toBe('agy');
  });

  it('Iniciar fica bloqueado se o operador escolher Claude sem sessão', async () => {
    api.listProviders.mockResolvedValue([
      {
        ...provider(CLAUDE),
        authStrategy: 'login-needed',
        loginHint:
          'Rode `claude auth login` no terminal. A sessão fica no Keychain.',
      },
      provider(CODEX),
    ]);
    const host = await renderAtExpress();
    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'Construir uma landing page com formulário de contato',
    );
    await flush();
    await flush();

    const tool = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Ferramenta de IA para Coordenar e revisar"]',
    );
    expect(tool).not.toBeNull();
    act(() => {
      tool!.value = 'claude';
      tool!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(
      host
        .querySelector('[data-category="orchestrator"]')
        ?.getAttribute('data-state'),
    ).toBe('needs-attention');
    expect(host.textContent).toContain('claude auth login');
    expect(button(host, 'Iniciar criação').disabled).toBe(true);

    act(() => button(host, 'Iniciar criação').click());
    await flush();
    expect(api.prepare).not.toHaveBeenCalled();
    act(() => button(host, 'Conectar ferramenta da equipe').click());
    expect(useProductNavigationStore.getState().destination).toMatchObject({
      kind: 'settings',
      section: 'providers',
    });
  });

  it('pula workers sem modelo configurado na rotação em vez de devolver null', () => {
    const cursor = adapter('cursor-agent', {
      models: { list: [], default: '' },
    });
    const adapters = [CLAUDE, CODEX, cursor];
    const providers = [provider(CLAUDE), provider(CODEX), provider(cursor)];
    const readiness = missionRuntimeReadiness(adapters, providers, []);

    const roster = buildRecommendedMissionRoster({
      readiness,
      providers,
      accounts: [],
      settings: ORCH_SETTINGS,
      objective: 'Construir uma landing page',
      lane: 'standard',
    });

    expect(roster).not.toBeNull();
    expect(roster?.some((agent) => agent.cli === 'cursor-agent')).toBe(false);
    expect(roster?.map((agent) => agent.category)).toEqual([
      'orchestrator',
      'executor',
      'executor',
      'reviewer',
    ]);
  });

  it('Iniciar missão segue mesmo com um worker sem modelo no inventário', async () => {
    const cursor = adapter('cursor-agent', {
      models: { list: [], default: '' },
    });
    api.listAdapters.mockResolvedValue([CLAUDE, CODEX, cursor]);
    api.listProviders.mockResolvedValue([
      provider(CLAUDE),
      provider(CODEX),
      provider(cursor),
    ]);
    const host = await renderAtExpress();

    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'Construir uma landing page',
    );
    await flush();
    await flush();

    act(() => button(host, 'Iniciar criação').click());
    await flush();

    expect(host.textContent).not.toContain(
      'Não foi possível montar uma equipe automática',
    );
    expect(api.prepare).toHaveBeenCalledTimes(1);
    const prepared = api.prepare.mock.calls[0]![0];
    expect(
      prepared.roster.some((agent) => agent.cli === 'cursor-agent'),
    ).toBe(false);
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it('Iniciar missão sem pasta ativa abre o seletor de pasta', async () => {
    const pick = vi.fn(async () => {});
    useWorkspaceStore.setState({ current: null, pick });
    const host = render(<MissionSetup />);
    await flush();

    const objective = objectiveField(
      host,
      'Seu pedido',
    );
    // A ideia pode ser escrita antes da pasta.
    expect(isObjectiveDisabled(objective)).toBe(false);
    enterText(objective, 'Construir uma landing page');
    await flush();
    expect(useMissionSetupStore.getState().draft.objective).toBe(
      'Construir uma landing page',
    );

    act(() => button(host, 'Escolher pasta e iniciar').click());
    await flush();

    expect(pick).toHaveBeenCalledTimes(1);
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('sem rota operacional mostra a mensagem amigável e bloqueia o Iniciar', async () => {
    api.listAdapters.mockResolvedValue([]);
    api.listProviders.mockResolvedValue([]);
    const host = await renderAtExpress();

    expect(host.textContent).toContain('Falta conectar uma ferramenta de IA');
    // O pré-requisito deixou de ser texto morto: existe um botão que resolve.
    expect(button(host, 'Conectar uma ferramenta de IA')).toBeDefined();
    expect([...host.querySelectorAll('button')].filter((item) =>
      item.textContent?.trim().startsWith('Conectar'),
    )).toHaveLength(1);

    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'Construir uma landing page',
    );
    await flush();
    act(() => button(host, 'Iniciar criação').click());
    await flush();

    expect(api.prepare).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'Falta conectar uma ferramenta de IA — use o botão “Conectar uma ferramenta de IA” logo acima.',
    );
  });

  it('equipe salva indisponível oferece uma única ação de conexão no aviso específico', async () => {
    api.listAdapters.mockResolvedValue([]);
    api.listProviders.mockResolvedValue([]);
    const host = await renderAtExpress();
    act(() => useMissionSetupStore.getState().setRoster(REVIEW_ROSTER));
    await flush();

    const issue = host.querySelector('#express-maestro-login');
    expect(issue?.textContent).toContain('Ferramenta não instalada');
    expect(host.querySelector('#express-provider-block')).toBeNull();
    expect([...host.querySelectorAll('button')].filter((item) =>
      item.textContent?.trim().startsWith('Conectar'),
    )).toHaveLength(1);
    expect(button(host, 'Iniciar criação').disabled).toBe(true);

    act(() => button(host, 'Conectar ferramenta da equipe').click());
    expect(useProductNavigationStore.getState().destination).toMatchObject({
      kind: 'settings',
      section: 'providers',
    });
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('objetivo de planejamento sela a lane plan', async () => {
    // Voo real 23/08: o Expresso fixava `standard`, então "só o plano, sem
    // escrever código" rodava como implementação — o coordenador abria
    // trabalhadores para escrever código, o oposto do pedido.
    const host = await renderAtExpress();
    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'planeje como adicionar um formulario de contato, só o plano, sem escrever codigo',
    );
    await flush();
    await flush();
    act(() => button(host, 'Iniciar criação').click());
    await flush();
    await flush();

    expect(api.prepare).toHaveBeenCalled();
    const request = api.prepare.mock.calls.at(-1)?.[0] as {
      advanced?: { lane?: string };
    };
    expect(request?.advanced?.lane).toBe('plan');
  });

  it('objetivo de trabalho comum continua em standard', async () => {
    const host = await renderAtExpress();
    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'crie uma landing page para minha barbearia',
    );
    await flush();
    await flush();
    act(() => button(host, 'Iniciar criação').click());
    await flush();
    await flush();

    const request = api.prepare.mock.calls.at(-1)?.[0] as {
      advanced?: { lane?: string };
    };
    expect(request?.advanced?.lane).toBe('standard');
  });

  it('Mais papéis e tamanho revela o wizard completo na etapa Equipe', async () => {
    const host = await renderAtExpress();
    enterText(
      objectiveField(
        host,
        'Seu pedido',
      ),
      'Construir uma landing page',
    );
    await flush();
    await flush();

    act(() => button(host, 'Mais papéis e tamanho').click());
    await flush();

    expect(host.querySelector('nav[aria-label="Etapas da missão"]')).not.toBeNull();
    expect(
      host.querySelector('[aria-current="step"]')?.textContent,
    ).toContain('Equipe');
    expect(host.textContent).not.toContain('O que você quer criar?');
    expect(button(host, 'Voltar para missão')).toBeDefined();
  });

  it('F-1170: clique num exemplo substitui o objetivo no editor e a digitação continua no fim', async () => {
    const host = await renderAtExpress();
    const objective = objectiveField(host, 'Seu pedido');
    enterText(objective, 'rascunho que será trocado');
    act(() => objective.editor.view.focus());
    act(() => button(host, 'Criar uma tela').click());
    const example =
      'crie uma página de contato simples com nome, e-mail e mensagem, no mesmo estilo do resto do site';
    expect(useMissionSetupStore.getState().draft.objective).toBe(example);
    expect(fieldValue(objective)).toBe(example);
    expect(objective.editor.state.doc.textContent).toBe(example);
    // O cursor estava no fim do rascunho maior: preso ao novo fim, sem perder o editor.
    act(() => objective.editor.view.dispatch(objective.editor.state.tr.insertText('!')));
    expect(useMissionSetupStore.getState().draft.objective).toBe(`${example}!`);
  });

  it('F-1170: ditado no Expresso acrescenta a fala como texto literal ao objetivo', async () => {
    const host = await renderAtExpress();
    const objective = objectiveField(host, 'Seu pedido');
    enterText(objective, 'Crie uma calculadora');
    act(() => {
      deliverDictationToClaim('que mostre 2*3*4 e use my_file.ts');
    });
    const stored = useMissionSetupStore.getState().draft.objective;
    expect(objectivePlainText(stored)).toBe('Crie uma calculadora que mostre 2*3*4 e use my_file.ts');
    expect(fieldValue(objective)).toBe(stored);
    expect(objective.editor.state.doc.textContent).toBe(
      'Crie uma calculadora que mostre 2*3*4 e use my_file.ts',
    );
  });

  it('F-1170: o teto do objetivo conta o markdown, igual ao schema do Main, e barra na borda com aviso', async () => {
    const host = await renderAtExpress();
    const objective = objectiveField(host, 'Seu pedido');
    const max = MISSION_INTENT_GOAL_MAX_CHARS;
    // `**b**` ocupa 5 caracteres do teto (o markdown é o que vai ao Main).
    enterText(objective, 'a'.repeat(max - 6));
    act(() => {
      const { editor } = objective;
      const end = editor.state.doc.content.size - 1;
      editor.view.dispatch(editor.state.tr.insertText('b', end).addMark(end, end + 1, editor.schema.marks.bold!.create()));
    });
    const belowMax = `${'a'.repeat(max - 6)}**b**`;
    expect(useMissionSetupStore.getState().draft.objective).toBe(belowMax);
    act(() => objective.editor.view.dispatch(objective.editor.state.tr.insertText('c', 1)));
    const atBorder = useMissionSetupStore.getState().draft.objective;
    expect(atBorder).toHaveLength(max);
    expect(atBorder.endsWith('**b**')).toBe(true);
    act(() => objective.editor.view.dispatch(objective.editor.state.tr.insertText('d', 1)));
    expect(useMissionSetupStore.getState().draft.objective).toBe(atBorder);
    expect(host.querySelector('.composer-tiptap__limit')?.textContent).toContain(
      `Limite de ${max} caracteres`,
    );

    // O Main é a autoridade: o pedido real na borda passa no schema; +1 não.
    act(() => button(host, 'Iniciar criação').click());
    await flush();
    const sent = api.prepare.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.objective).toBe(atBorder);
    expect(missionPrepareRequestSchema.safeParse(sent).success).toBe(true);
    expect(missionPrepareRequestSchema.safeParse({ ...sent, objective: `${atBorder}d` }).success).toBe(false);
  });

});

describe('MissionStep — objetivo no editor rich-text (F-1170)', () => {
  it('ditado acrescenta a fala, foca o objetivo e põe o cursor no fim', async () => {
    const host = render(<MissionSetup />);
    await flush();
    const objective = objectiveField(host, 'O que você quer que a equipe entregue?');
    enterText(objective, 'Corrija o checkout');
    act(() => objective.editor.commands.setTextSelection(3));
    act(() => {
      deliverDictationToClaim('e prove com um teste');
    });
    expect(useMissionSetupStore.getState().draft.objective).toBe(
      'Corrija o checkout e prove com um teste',
    );
    expect(fieldValue(objective)).toBe('Corrija o checkout e prove com um teste');
    expect(document.activeElement).toBe(objective);
    expect(objective.editor.state.selection.empty).toBe(true);
    expect(objective.editor.state.selection.from).toBe(
      Selection.atEnd(objective.editor.state.doc).from,
    );
  });

  it('o objetivo formatado chega ao prepare em markdown, e o rótulo nomeia o editor', async () => {
    const host = render(<MissionSetup />);
    await flush();
    const objective = objectiveField(host, 'O que você quer que a equipe entregue?');
    expect(document.getElementById(objective.getAttribute('aria-labelledby')!)?.textContent).toContain(
      'O que você quer que a equipe entregue?',
    );
    enterText(objective, 'Corrija o total');
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    act(() => {
      objective.editor.commands.setTextSelection({ from: 1, to: 8 });
      objective.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'b', keyCode: 66, ...mod }),
      );
    });
    expect(useMissionSetupStore.getState().draft.objective).toBe('**Corrija** o total');
  });
});
