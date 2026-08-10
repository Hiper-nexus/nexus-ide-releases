/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { AccountInfo } from '../../../shared/account-types';
import type {
  MissionReview,
  MissionSnapshot,
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
    missionControlCapable: id === 'claude',
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

function enterText(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
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
    fieldByLabel<HTMLTextAreaElement>(
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

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(api)) mock.mockClear();
  api.listAdapters.mockResolvedValue([CLAUDE, CODEX]);
  api.listProviders.mockResolvedValue(PROVIDERS);
  api.listAccounts.mockResolvedValue(ACCOUNTS);
  api.getOrchSettings.mockResolvedValue(ORCH_SETTINGS);
  api.prepare.mockResolvedValue(REVIEW);
  api.start.mockResolvedValue(SNAPSHOT);
  installNexusApi();

  useWorkspaceStore.setState({
    ...initialWorkspaceState,
    current: WORKSPACE,
    recents: [WORKSPACE],
    hydrated: true,
  });
  useMissionSetupStore.setState({
    workspacePath: null,
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

  it('clamps stale consult grants without changing customized role identity', () => {
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
        allowedTools: ['Read'],
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
        allowedTools: ['Read'],
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

    const objective = fieldByLabel<HTMLTextAreaElement>(
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
    expect(
      fieldByLabel<HTMLInputElement>(host, 'Pasta do projeto').value,
    ).toBe(OTHER_WORKSPACE.path);
    expect(useMissionSetupStore.getState().workspacePath).toBe(
      OTHER_WORKSPACE.path,
    );
  });

  it('focuses a workspace error when no project is active', async () => {
    useWorkspaceStore.setState({ current: null });
    const host = render(<MissionSetup />);
    await flush();

    act(() => button(host, 'Continuar para equipe').click());
    const error = host.querySelector<HTMLElement>('#mission-workspace-error');
    expect(error?.textContent).toContain('Escolha uma pasta de projeto');
    expect(document.activeElement).toBe(error);
  });

  it('keeps draft controls disabled until a project exists and explains the next action', async () => {
    useWorkspaceStore.setState({ current: null });
    const host = render(<MissionSetup />);
    await flush();

    const objective = fieldByLabel<HTMLTextAreaElement>(
      host,
      'O que você quer que a equipe entregue?',
    );
    const title = fieldByLabel<HTMLInputElement>(
      host,
      'Nome da missão (opcional)',
    );
    const context = fieldByLabel<HTMLInputElement>(
      host,
      'Adicionar arquivo ou referência',
    );
    const lane = fieldByLabel<HTMLSelectElement>(host, 'Tipo de trabalho');
    const advanced = Array.from(host.querySelectorAll('details')).find(
      (item) => item.querySelector('summary')?.textContent === 'Avançado',
    );
    const advancedSummary = advanced?.querySelector('summary');
    const reason = host.querySelector<HTMLElement>(
      '#mission-draft-disabled-reason',
    );

    expect(button(host, 'Escolher pasta').disabled).toBe(false);
    expect(objective.disabled).toBe(true);
    expect(title.disabled).toBe(true);
    expect(context.disabled).toBe(true);
    expect(button(host, 'Adicionar contexto').disabled).toBe(true);
    expect(lane.disabled).toBe(true);
    expect(advancedSummary?.getAttribute('aria-disabled')).toBe('true');
    expect(reason?.textContent).toContain(
      'Escolha uma pasta de projeto para preencher os dados da missão.',
    );
    expect(objective.getAttribute('aria-describedby')).toContain(
      'mission-draft-disabled-reason',
    );

    act(() => advancedSummary?.click());
    expect(advanced?.open).toBe(false);
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
      fieldByLabel<HTMLTextAreaElement>(
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
    const host = render(<MissionSetup />);
    await flush();

    expect(host.textContent).toContain(
      'Não foi possível ler o rascunho salvo',
    );
    expect(
      fieldByLabel<HTMLTextAreaElement>(
        host,
        'O que você quer que a equipe entregue?',
      ).disabled,
    ).toBe(true);

    storage.restore();
    act(() => button(host, 'Tentar ler novamente').click());
    await flush();

    const objective = fieldByLabel<HTMLTextAreaElement>(
      host,
      'O que você quer que a equipe entregue?',
    );
    expect(objective.disabled).toBe(false);
    expect(objective.value).toBe('Rascunho salvo antes da falha de leitura');
    expect(host.textContent).not.toContain('Rascunho somente na memória');
  });


  it('focuses the persisted-draft read alert or its first recovery action instead of the blocked step', async () => {
    withStorageFailure({
      getItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const host = render(<MissionSetup />);
    await flush();

    const readAlert = Array.from(
      host.querySelectorAll<HTMLElement>('[role="alert"]'),
    ).find((item) =>
      item.textContent?.includes('Não foi possível ler o rascunho salvo'),
    );
    const retry = button(host, 'Tentar ler novamente');
    const blockedStepHeading =
      host.querySelector<HTMLHeadingElement>('#mission-step-title');
    const objective = fieldByLabel<HTMLTextAreaElement>(
      host,
      'O que você quer que a equipe entregue?',
    );

    expect(objective.disabled).toBe(true);
    expect([readAlert, retry]).toContain(document.activeElement);
    expect(document.activeElement).not.toBe(blockedStepHeading);
  });
  it('discards a corrupt saved draft through the visible recovery action and keeps editing available when replacement storage fails', async () => {
    localStorage.setItem(
      missionSetupStorageKey(WORKSPACE.path),
      '{rascunho-corrompido',
    );
    const host = render(<MissionSetup />);
    await flush();

    const blockedObjective = fieldByLabel<HTMLTextAreaElement>(
      host,
      'O que você quer que a equipe entregue?',
    );
    expect(host.textContent).toContain('O rascunho salvo está corrompido');
    expect(blockedObjective.disabled).toBe(true);

    withStorageFailure({
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });
    act(() =>
      button(host, 'Descartar rascunho salvo e começar vazio').click(),
    );
    await flush();

    const objective = fieldByLabel<HTMLTextAreaElement>(
      host,
      'O que você quer que a equipe entregue?',
    );
    expect(objective.value).toBe('');
    expect(objective.disabled).toBe(false);
    expect(
      fieldByLabel<HTMLInputElement>(host, 'Nome da missão (opcional)')
        .disabled,
    ).toBe(false);
    expect(
      fieldByLabel<HTMLInputElement>(
        host,
        'Adicionar arquivo ou referência',
      ).disabled,
    ).toBe(false);
    expect(
      fieldByLabel<HTMLSelectElement>(host, 'Tipo de trabalho').disabled,
    ).toBe(false);
    expect(host.textContent).not.toContain(
      'O rascunho salvo está corrompido',
    );
    expect(host.textContent).toContain('O armazenamento local está cheio');
    expect(host.textContent).toContain('Rascunho somente na memória');

    enterText(objective, 'Começar uma missão nova depois do descarte');
    await flush();

    expect(objective.value).toBe(
      'Começar uma missão nova depois do descarte',
    );
    expect(objective.disabled).toBe(false);
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
    expect(
      fieldByLabel<HTMLSelectElement>(
        host,
        'Ferramenta de IA para Coordenar e revisar',
      ).value,
    ).toBe('claude');
    expect(
      fieldByLabel<HTMLSelectElement>(host, 'Modelo para Coordenar e revisar')
        .value,
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

    const objective = fieldByLabel<HTMLTextAreaElement>(
      host,
      'O que você quer que a equipe entregue?',
    );
    expect(objective.value).toBe('');
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
      {
        agentName: 'Coordenar consulta',
        allowedTools: ['Read'],
      },
      {
        agentName: 'Auditar interface',
        allowedTools: ['Read'],
      },
      {
        agentName: 'Sintetizar recomendações',
        allowedTools: ['Read'],
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

  it('clamps an existing customized standard roster when the lane changes before prepare', async () => {
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
    expect(
      prepared.roster.map(({ id, allowedTools }) => ({ id, allowedTools })),
    ).toEqual([
      { id: 'mission-coordinator', allowedTools: ['Read'] },
      { id: 'interface-executor', allowedTools: ['Read'] },
      { id: 'engine-executor', allowedTools: ['Read'] },
      { id: 'result-reviewer', allowedTools: ['Read'] },
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
      allowedTools: ['Read'],
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

  it('exposes the trusted prepare and start edges on the canonical setup controls', async () => {
    const host = await renderAtTeam();
    const prepare = button(host, 'Continuar para revisão');

    expect(prepare.dataset.nexusRealMissionWizardLaunch).toBe('prepare');

    act(() => prepare.click());
    await flush();

    expect(button(host, 'Iniciar missão').dataset.nexusRealMissionWizardLaunch).toBe(
      'start',
    );
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
      'O agente de coordenação encerrou antes de aceitar o início',
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
      fieldByLabel<HTMLTextAreaElement>(
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
