/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  missionSnapshotSchema,
  type MissionEngineCommand,
  type MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import {
  missionEventSchema,
  type MissionEvent,
} from '../../../shared/mission-events';
import { useMissionInspectorStore } from '../../state/mission-inspector-store';
import {
  directionUnavailableReason,
  MissionInspector,
} from './MissionInspector';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IMPLEMENTATION_TITLE =
  'Implementar o painel canônico preservando integralmente dependências, evidências e a orientação aprovada pelo operador';
const RESULT_SUMMARY =
  'A entrega terminou parcialmente: o painel canônico foi integrado, a navegação por teclado foi verificada e a trilha de evidências permaneceu completa. O único limite registrado foi a validação externa do artefato de distribuição, que deve continuar explícito em vez de ser resumido ou visualmente truncado.';

const SNAPSHOT: MissionSnapshot = missionSnapshotSchema.parse({
  id: 'mission-inspector-canonical',
  title: 'Painel canônico da missão',
  objective: 'Projetar somente o estado persistido pelo motor de missão.',
  workspaceLabel: 'nexus (/projects/nexus)',
  state: 'blocked_user',
  stateReason: {
    code: 'operator-choice-required',
    label: 'Decisão do operador necessária',
    detail: 'Escolha a forma de publicar a evidência final.',
  },
  progress: { completed: 1, total: 3 },
  agents: [
    {
      id: 'agent-orchestrator',
      agentName: 'Coordenação principal',
      category: 'orchestrator',
      cli: 'claude',
      providerId: 'anthropic-subscription',
      model: 'claude-opus-4-1',
      effort: 'high',
      instructions: 'Coordene a missão e preserve as decisões do operador.',
      ownsPlanDocs: true,
      allowedSkills: ['bmad-templates'],
      allowedTools: ['Read', 'Task'],
      persona: 'Líder de missão',
      state: 'waiting',
      currentUnitId: 'unit-review',
      paneId: 'pane-orchestrator-full',
      detail: 'Aguardando a decisão solicitada ao operador.',
    },
    {
      id: 'agent-builder',
      agentName: 'Implementadora de interface sem abreviação',
      category: 'executor',
      cli: 'codex',
      providerId: 'openai-subscription',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      instructions:
        'Implemente os contratos observáveis e mantenha todo o texto acessível.',
      ownsPlanDocs: true,
      allowedSkills: ['react-patterns', 'a11y-debugging'],
      allowedTools: ['Read', 'Edit'],
      persona: 'Engenheira cuidadosa',
      state: 'blocked',
      currentUnitId: 'unit-implementation',
      paneId: 'pane-builder-full',
      detail: 'Bloqueada somente pela escolha explícita do operador.',
    },
    {
      id: 'agent-reviewer',
      agentName: 'Revisora final',
      category: 'reviewer',
      cli: 'agy',
      providerId: 'antigravity-cli',
      model: 'gemini-2.5-pro',
      effort: 'high',
      instructions: 'Revise o resultado contra cada evidência canônica.',
      ownsPlanDocs: false,
      allowedSkills: [],
      allowedTools: ['Read'],
      persona: 'Revisora independente',
      state: 'queued',
      paneId: 'pane-reviewer-full',
      detail: 'Na fila até a implementação ser liberada.',
    },
  ],
  edges: [
    {
      id: 'edge-delegation',
      sourceAgentId: 'agent-orchestrator',
      targetAgentId: 'agent-builder',
      kind: 'delegation',
      label: 'Implementação canônica',
    },
    {
      id: 'edge-review',
      sourceAgentId: 'agent-builder',
      targetAgentId: 'agent-reviewer',
      kind: 'review',
      label: 'Revisão independente',
    },
  ],
  units: [
    {
      id: 'unit-discovery',
      title:
        'Confirmar o contrato persistido completo antes de qualquer projeção visual',
      status: 'done',
      agentId: 'agent-orchestrator',
      dependsOn: [],
      evidenceIds: [
        'evidence-contract-source',
        'evidence-contract-validation',
      ],
    },
    {
      id: 'unit-implementation',
      title: IMPLEMENTATION_TITLE,
      status: 'blocked',
      agentId: 'agent-builder',
      dependsOn: ['unit-discovery'],
      evidenceIds: ['evidence-rendered-board', 'evidence-keyboard-path'],
    },
    {
      id: 'unit-review',
      title: 'Revisar todos os artefatos sem inferir ondas que não foram persistidas',
      status: 'pending',
      agentId: 'agent-reviewer',
      dependsOn: ['unit-discovery', 'unit-implementation'],
      evidenceIds: ['evidence-review-checklist'],
    },
  ],
  question: {
    id: 'question-publication',
    prompt: 'Como a evidência final deve ser publicada?',
    detail: 'A escolha altera somente o destino do artefato, não o plano aprovado.',
    targetAgentId: 'agent-orchestrator',
    options: [
      {
        id: 'option-local',
        label: 'Somente no workspace',
        description: 'Persiste os artefatos no projeto atual.',
      },
      {
        id: 'option-release',
        label: 'Anexar à entrega',
        description: 'Inclui as referências no resultado final.',
      },
    ],
    allowFreeText: true,
  },
  allowedActions: ['answer-question', 'direct', 'stop'],
  version: 17,
  updatedAt: 1_786_080_000_000,
});

const RESULT_SNAPSHOT: MissionSnapshot = missionSnapshotSchema.parse({
  ...SNAPSHOT,
  state: 'completed',
  stateReason: undefined,
  question: undefined,
  result: {
    outcome: 'partial',
    summary: RESULT_SUMMARY,
    evidenceIds: [
      'evidence-contract-source',
      'evidence-rendered-board',
      'evidence-keyboard-path',
    ],
    artifactRefs: [
      'artifact://mission/report-completo.html',
      'artifact://mission/auditoria-acessibilidade.json',
    ],
  },
  allowedActions: [],
  version: 18,
  updatedAt: 1_786_080_010_000,
});

const TERMINAL_WITHOUT_RESULT: MissionSnapshot = missionSnapshotSchema.parse({
  ...SNAPSHOT,
  state: 'failed',
  stateReason: {
    code: 'result-not-persisted',
    label: 'Falha no fechamento',
    detail: 'O processo terminou antes de persistir o resultado canônico.',
  },
  question: undefined,
  result: undefined,
  allowedActions: [],
  version: 19,
  updatedAt: 1_786_080_020_000,
});

function event(overrides: Partial<MissionEvent> = {}): MissionEvent {
  return missionEventSchema.parse({
    sequence: 1,
    id: 'event-default',
    missionId: SNAPSHOT.id,
    runId: 'run-canonical',
    type: 'mission.run_started',
    payload: {},
    idempotencyKey: 'event-key-default',
    occurredAt: 1_786_080_000_000,
    origin: 'main',
    deliveryStatus: 'delivered',
    ...overrides,
  });
}

const ACCEPTED_DIRECTION_EVENTS: MissionEvent[] = [
  event({
    sequence: 4,
    id: 'direction-everyone',
    runId: 'operator-direction',
    type: 'custom',
    payload: {
      kind: 'operator_direction',
      targetAgentId: null,
      text: 'Preservem cada referência de evidência na entrega final.',
    },
    idempotencyKey: `operator_direction:${'a'.repeat(64)}`,
    occurredAt: 1_786_080_004_000,
  }),
  event({
    sequence: 5,
    id: 'direction-builder',
    runId: 'operator-direction',
    type: 'custom',
    payload: {
      kind: 'operator_direction',
      targetAgentId: 'agent-builder',
      text: 'Mantenha o título integral mesmo quando ele ultrapassar uma linha.',
    },
    idempotencyKey: `operator_direction:${'b'.repeat(64)}`,
    occurredAt: 1_786_080_005_000,
  }),
  event({
    sequence: 6,
    id: 'unaccepted-renderer-lookalike',
    runId: 'renderer-attempt',
    type: 'custom',
    payload: {
      kind: 'operator_direction',
      targetAgentId: null,
      text: 'NÃO EXIBIR: esta orientação não foi aceita pelo processo principal.',
    },
    idempotencyKey: 'renderer-direction-lookalike',
    occurredAt: 1_786_080_006_000,
    origin: 'renderer',
  }),
  event({
    sequence: 7,
    id: 'observer-not-a-chat-reply',
    type: 'observer.turn_ended',
    payload: {
      observer: { outcome: 'completed' },
      text: 'NÃO EXIBIR: resposta de agente inventada a partir da atividade.',
    },
    idempotencyKey: 'observer-event-key',
    occurredAt: 1_786_080_007_000,
  }),
];

const ACTIVITY_EVENTS: MissionEvent[] = [
  event({
    sequence: 3,
    id: 'safe-tool-call',
    type: 'observer.tool_call',
    payload: {
      observer: {
        toolName: 'Read',
        arguments: {
          path: 'SEGREDO_ARGUMENTO_BRUTO_NAO_RENDERIZAR',
        },
        ptyOutput: 'SEGREDO_PTY_BRUTO_NAO_RENDERIZAR',
      },
      rawToolArguments: 'SEGREDO_ARGUMENTO_BRUTO_NAO_RENDERIZAR',
      rawPtyOutput: 'SEGREDO_PTY_BRUTO_NAO_RENDERIZAR',
    },
    idempotencyKey: 'safe-tool-event',
    occurredAt: 1_786_080_003_000,
  }),
  event({
    sequence: 2,
    id: 'malformed-observer-payload',
    type: 'observer.tool_call',
    payload: {
      observer: 'payload-malformado-em-vez-de-objeto',
      rawToolArguments: 'MALFORMADO_NAO_RENDERIZAR',
    },
    idempotencyKey: 'malformed-event',
    occurredAt: 1_786_080_002_000,
  }),
  event({
    sequence: 1,
    id: 'run-started',
    type: 'mission.run_started',
    payload: {},
    idempotencyKey: 'run-started-event',
    occurredAt: 1_786_080_001_000,
  }),
];

const ACTIVE_QUESTION: ReactNode = (
  <section aria-label="Pergunta ativa da missão">
    <h3>Como a evidência final deve ser publicada?</h3>
    <p>A escolha altera somente o destino do artefato, não o plano aprovado.</p>
    <button type="button">Somente no workspace</button>
    <button type="button">Anexar à entrega</button>
  </section>
);

interface MountOptions {
  readonly snapshot?: MissionSnapshot;
  readonly events?: MissionEvent[];
  readonly question?: ReactNode;
  readonly onOpenTerminals?: () => void;
}

const mountedRoots = new Set<Root>();

function mount({
  snapshot = SNAPSHOT,
  events = [],
  question = ACTIVE_QUESTION,
  onOpenTerminals,
}: MountOptions = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  const onCommand = vi.fn(
    async (_command: MissionEngineCommand): Promise<MissionSnapshot> => snapshot,
  );

  act(() => {
    root.render(
      <MissionInspector
        snapshot={snapshot}
        events={events}
        onCommand={onCommand}
        question={question}
        onOpenTerminals={onOpenTerminals}
      />,
    );
  });

  return host;
}

function tabs(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    host.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
}

function tab(host: HTMLElement, name: string): HTMLButtonElement {
  const found = tabs(host).find((candidate) => candidate.textContent === name);
  if (!found) throw new Error(`Tab not found: ${name}`);
  return found;
}

function selectTab(host: HTMLElement, name: string): HTMLElement {
  const selected = tab(host, name);
  act(() => selected.click());
  const panelId = selected.getAttribute('aria-controls');
  const panel = panelId ? document.getElementById(panelId) : null;
  if (!panel || !host.contains(panel)) {
    throw new Error(`Panel not found for tab: ${name}`);
  }
  return panel;
}

beforeEach(() => {
  useMissionInspectorStore.setState({
    missionId: null,
    tab: 'agent',
    selectedAgentId: null,
  });
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
  });
  mountedRoots.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('directionUnavailableReason', () => {
  it('missão completed aponta o Maestro vivo, não só o botão do quadro', () => {
    expect(directionUnavailableReason('completed')).toMatch(/Digite no Maestro/);
    expect(directionUnavailableReason('completed')).toMatch(/Pedir um ajuste/);
  });
});

describe('MissionInspector', () => {
  it('exposes exactly six native, linked tabs and moves the selected tabpanel', () => {
    const host = mount();
    const expectedTabs = [
      'Agente',
      'Plano',
      'Conversa',
      'Atividade',
      'Equipe',
      'Resultado',
    ];
    const tablist = host.querySelector('[role="tablist"]');
    const renderedTabs = tabs(host);

    expect(tablist).not.toBeNull();
    expect(renderedTabs).toHaveLength(6);
    expect(renderedTabs.map((item) => item.textContent)).toEqual(expectedTabs);
    expect(
      renderedTabs.filter((item) => item.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
    expect(tab(host, 'Agente').getAttribute('aria-selected')).toBe('true');
    expect(
      host.querySelector('[data-testid="mission-inspector-terminals"]'),
    ).toBeNull();

    for (const current of renderedTabs) {
      expect(current.tagName).toBe('BUTTON');
      expect(current.id).not.toBe('');
      const panelId = current.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      const panel = panelId ? document.getElementById(panelId) : null;
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(current.id);
    }

    for (const name of expectedTabs) {
      const panel = selectTab(host, name);
      expect(tab(host, name).getAttribute('aria-selected')).toBe('true');
      expect(panel.hidden).toBe(false);
      expect(
        tabs(host).filter(
          (item) => item.getAttribute('aria-selected') === 'true',
        ),
      ).toHaveLength(1);

      for (const other of tabs(host).filter(
        (candidate) => candidate.textContent !== name,
      )) {
        expect(other.getAttribute('aria-selected')).toBe('false');
        const otherPanelId = other.getAttribute('aria-controls');
        const otherPanel = otherPanelId
          ? document.getElementById(otherPanelId)
          : null;
        expect(otherPanel?.hidden).toBe(true);
      }
    }
  });

  it('oferece Terminais fora da tablist (F-005)', () => {
    const onOpenTerminals = vi.fn();
    const host = mount({ onOpenTerminals });
    const cta = host.querySelector<HTMLButtonElement>(
      '[data-testid="mission-inspector-terminals"]',
    );
    expect(cta).not.toBeNull();
    expect(cta?.getAttribute('role')).not.toBe('tab');
    expect(cta?.textContent).toMatch(/Terminais/);
    expect(tabs(host)).toHaveLength(6);
    act(() => cta!.click());
    expect(onOpenTerminals).toHaveBeenCalledTimes(1);
  });

  it('projects every canonical field for the selected agent without invented metrics', () => {
    useMissionInspectorStore.getState().bindSnapshot(SNAPSHOT);
    useMissionInspectorStore.getState().selectAgent('agent-builder');

    const host = mount();
    const panel = selectTab(host, 'Agente');
    const text = panel.textContent ?? '';

    for (const value of [
      'Implementadora de interface sem abreviação',
      'agent-builder',
      'codex',
      'openai-subscription',
      'gpt-5.6-sol',
      'ultra',
      'Engenheira cuidadosa',
      'pane-builder-full',
      'unit-implementation',
      IMPLEMENTATION_TITLE,
      'Bloqueada somente pela escolha explícita do operador.',
      'Implemente os contratos observáveis e mantenha todo o texto acessível.',
      'react-patterns',
      'a11y-debugging',
      'Read',
      'Edit',
    ]) {
      expect(text).toContain(value);
    }
    expect(text).toMatch(/executor/i);
    expect(text).toMatch(/bloquead[ao]/i);
    expect(text).toMatch(/documentos do plano/i);

    for (const inventedMetric of [
      'Taxa de sucesso',
      'Tokens usados',
      'Custo estimado',
      'Latência média',
      'Eficiência',
    ]) {
      expect(text).not.toContain(inventedMetric);
    }
  });

  it('shows every canonical plan unit, owner, dependency, and evidence id in full', () => {
    const host = mount();
    const panel = selectTab(host, 'Plano');
    const text = panel.textContent ?? '';

    for (const value of [
      'unit-discovery',
      'Confirmar o contrato persistido completo antes de qualquer projeção visual',
      'Coordenação principal',
      'evidence-contract-source',
      'evidence-contract-validation',
      'unit-implementation',
      IMPLEMENTATION_TITLE,
      'Implementadora de interface sem abreviação',
      'unit-discovery',
      'evidence-rendered-board',
      'evidence-keyboard-path',
      'unit-review',
      'Revisar todos os artefatos sem inferir ondas que não foram persistidas',
      'Revisora final',
      'unit-implementation',
      'evidence-review-checklist',
    ]) {
      expect(text).toContain(value);
    }
    expect(text).toMatch(/concluíd[ao]/i);
    expect(text).toMatch(/bloquead[ao]/i);
    expect(text).toMatch(/pendente/i);
    expect(text).not.toMatch(/\bonda\s+\d+/i);
  });

  it('F-1167: a aba Plano tem a seção "Motor de decisão" desta missão, lida por IPC só leitura', async () => {
    const missionPanel = vi.fn(async (missionId: string) => ({ ok: true, missionId, mode: 'auto', budgetUsd: 0.5, chargedUsd: 0.1, reservedUsd: 0,
      usd: 0.0001, calls: 1, noAnswer: 0, budgetRefusals: 0, ratio: 0.2, byProvider: {}, hints: null }));
    const previous = (window as unknown as { nexus?: unknown }).nexus;
    Object.defineProperty(window, 'nexus', { configurable: true, value: { decisionModels: { missionPanel } } });
    try {
      const host = mount();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      const panel = selectTab(host, 'Plano');
      expect(missionPanel).toHaveBeenCalledWith(SNAPSHOT.id);
      const section = panel.querySelector('section[aria-label="Motor de decisão"]');
      expect(section?.textContent).toContain('US$ 0,1000 de US$ 0,5000');
    } finally {
      Object.defineProperty(window, 'nexus', { configurable: true, value: previous });
    }
  });

  it('shows only accepted operator directions with the supplied question and real composer', () => {
    const host = mount({ events: ACCEPTED_DIRECTION_EVENTS });
    const panel = selectTab(host, 'Conversa');
    const text = panel.textContent ?? '';

    expect(text).toContain(
      'Preservem cada referência de evidência na entrega final.',
    );
    expect(text).toContain(
      'Mantenha o título integral mesmo quando ele ultrapassar uma linha.',
    );
    expect(text).not.toContain(
      'NÃO EXIBIR: esta orientação não foi aceita pelo processo principal.',
    );
    expect(text).not.toContain(
      'NÃO EXIBIR: resposta de agente inventada a partir da atividade.',
    );

    const question = panel.querySelector(
      '[aria-label="Pergunta ativa da missão"]',
    );
    expect(question?.textContent).toContain(
      'Como a evidência final deve ser publicada?',
    );
    expect(question?.textContent).toContain(
      'A escolha altera somente o destino do artefato, não o plano aprovado.',
    );

    const composer = panel.querySelector('form');
    expect(composer).not.toBeNull();
    expect(composer?.querySelector('select')?.textContent).toContain('@todos');
    // F-1170: o rascunho é o editor rich-text (Tiptap) do DirectionComposer.
    expect(composer?.querySelector('[role="textbox"][contenteditable="true"]')).not.toBeNull();
    expect(composer?.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it.each(['queued', 'unproven', 'delivered'] as const)('F-1105: shows %s delivery on the same queued direction independently of journal ACK', state => {
    const accepted = event({ ...ACCEPTED_DIRECTION_EVENTS[0], payload: { ...ACCEPTED_DIRECTION_EVENTS[0].payload, deliveryState: 'queued', directionId: 'a'.repeat(64) } });
    const outcome = event({ sequence: 8, id: 'direction-delivery', runId: 'operator-direction', type: 'custom',
      idempotencyKey: `operator_direction_delivery:${'a'.repeat(64)}:${state}`,
      payload: { kind: 'operator_direction_delivery', directionId: 'a'.repeat(64), deliveryState: state,
        reason: state === 'delivered' ? 'acceptance_proved' : 'delivery_unavailable' } });
    const panel = selectTab(mount({ events: state === 'queued' ? [accepted] : [outcome, accepted] }), 'Conversa');
    const rows = panel.querySelectorAll('.mission-inspector__direction-list li');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(accepted.payload.text);
    expect(rows[0].textContent).toContain(state === 'queued' ? 'Na fila de início da coordenação.' :
      state === 'delivered' ? 'Entrega confirmada.' : 'Entrega não confirmada. A orientação pode ter sido recebida.');
  });

  it.each([null, undefined])('F-1105: unrelated malformed payload %s cannot crash or change a queued direction', payload => {
    const accepted = event({ ...ACCEPTED_DIRECTION_EVENTS[0], payload: { ...ACCEPTED_DIRECTION_EVENTS[0].payload, deliveryState: 'queued', directionId: 'a'.repeat(64) } });
    const malformed = { ...event({ id: 'malformed-unrelated', sequence: 9, type: 'mission.status_changed' }), payload } as unknown as MissionEvent;
    const rows = selectTab(mount({ events: [accepted, malformed] }), 'Conversa').querySelectorAll('.mission-inspector__direction-list li');
    expect(rows).toHaveLength(1); expect(rows[0].textContent).toContain('Na fila de início da coordenação.');
  });

  it.each(['foreign-mission', 'foreign-direction', 'foreign-origin', 'foreign-run', 'wrong-key', 'stale', 'bad-reason', 'extra-body'] as const)(
    'F-1105: a %s outcome cannot settle a queued direction', changed => {
      const accepted = event({ ...ACCEPTED_DIRECTION_EVENTS[0], payload: { ...ACCEPTED_DIRECTION_EVENTS[0].payload, deliveryState: 'queued', directionId: 'a'.repeat(64) } });
      const payload: Record<string, unknown> = { kind: 'operator_direction_delivery', directionId: 'a'.repeat(64), deliveryState: 'delivered', reason: 'acceptance_proved' };
      if (changed === 'foreign-direction') payload.directionId = 'b'.repeat(64);
      if (changed === 'bad-reason') payload.reason = 'delivery_unavailable';
      if (changed === 'extra-body') payload.text = 'untrusted raw error/body';
      const outcome = event({ sequence: changed === 'stale' ? 2 : 8, id: 'wrong-delivery', runId: changed === 'foreign-run' ? 'foreign' : 'operator-direction', type: 'custom',
        missionId: changed === 'foreign-mission' ? 'other-mission' : SNAPSHOT.id,
        origin: changed === 'foreign-origin' ? 'renderer' : 'main',
        idempotencyKey: changed === 'wrong-key' ? 'operator-direction-invalid' : `operator_direction_delivery:${'a'.repeat(64)}:delivered`, payload });
      const panel = selectTab(mount({ events: [accepted, outcome] }), 'Conversa');
      expect(panel.querySelector('.mission-inspector__direction-list')?.textContent).toContain('Na fila de início da coordenação.');
      expect(panel.querySelector('.mission-inspector__direction-list')?.textContent).not.toContain('Entrega confirmada.');
    });

  it('F-1105: a later proved outcome settles only its own unproven direction, and stale uncertainty cannot overwrite proof', () => {
    const first = event({ ...ACCEPTED_DIRECTION_EVENTS[0], payload: { ...ACCEPTED_DIRECTION_EVENTS[0].payload, deliveryState: 'queued', directionId: 'a'.repeat(64) } });
    const second = event({ ...ACCEPTED_DIRECTION_EVENTS[1], payload: { ...ACCEPTED_DIRECTION_EVENTS[1].payload, deliveryState: 'queued', directionId: 'b'.repeat(64) } });
    const unproven = event({ sequence: 8, id: 'unproven-delivery', runId: 'operator-direction', type: 'custom', idempotencyKey: `operator_direction_delivery:${'a'.repeat(64)}:unproven`,
      payload: { kind: 'operator_direction_delivery', directionId: 'a'.repeat(64), deliveryState: 'unproven', reason: 'delivery_unavailable' } });
    const proved = event({ ...unproven, sequence: 9, id: 'proved-delivery', idempotencyKey: `operator_direction_delivery:${'a'.repeat(64)}:delivered`,
      payload: { ...unproven.payload, deliveryState: 'delivered', reason: 'acceptance_proved' } });
    const lateUncertainty = event({ ...unproven, sequence: 10, id: 'late-unproven' });
    const rows = selectTab(mount({ events: [lateUncertainty, proved, second, unproven, first] }), 'Conversa').querySelectorAll('.mission-inspector__direction-list li');
    expect(rows).toHaveLength(2); expect(rows[0].textContent).toContain('Entrega confirmada.');
    expect(rows[0].textContent).not.toContain('Entrega não confirmada.'); expect(rows[1].textContent).toContain('Na fila de início da coordenação.');
  });

  it('states explicitly when Conversation has no accepted operator direction', () => {
    const host = mount({
      events: [
        event({
          id: 'ordinary-activity',
          type: 'agent.spawned',
          payload: { agentId: 'agent-builder' },
          idempotencyKey: 'ordinary-activity-event',
        }),
      ],
    });
    const panel = selectTab(host, 'Conversa');

    expect(panel.textContent).toMatch(/nenhuma orientação.*ainda/i);
    expect(panel.textContent).not.toMatch(/resposta (do|de) agente/i);
  });

  it('orders normalized activity and drops malformed or unsafe raw content', () => {
    const host = mount({ events: ACTIVITY_EVENTS });
    const panel = selectTab(host, 'Atividade');
    const items = Array.from(panel.querySelectorAll('li'));

    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Execução iniciada');
    expect(items[1]?.textContent).toContain('Ferramenta Read chamada');
    expect(panel.textContent).not.toContain('payload-malformado-em-vez-de-objeto');
    expect(panel.textContent).not.toContain('MALFORMADO_NAO_RENDERIZAR');
    expect(panel.textContent).not.toContain(
      'SEGREDO_ARGUMENTO_BRUTO_NAO_RENDERIZAR',
    );
    expect(panel.textContent).not.toContain('SEGREDO_PTY_BRUTO_NAO_RENDERIZAR');
  });

  it('uses beginner PT-BR terms for every technical activity label', () => {
    const host = mount({
      events: [
        event({
          sequence: 1,
          id: 'driver-tick',
          type: 'driver.tick',
          idempotencyKey: 'driver-tick-event',
        }),
        event({
          sequence: 2,
          id: 'driver-error',
          type: 'driver.error',
          idempotencyKey: 'driver-error-event',
        }),
        event({
          sequence: 3,
          id: 'turn-started',
          type: 'observer.turn_started',
          payload: { observer: { turnSequence: 4 } },
          idempotencyKey: 'turn-started-event',
        }),
        event({
          sequence: 4,
          id: 'turn-completed',
          type: 'observer.turn_ended',
          payload: { observer: { outcome: 'completed' } },
          idempotencyKey: 'turn-completed-event',
        }),
        event({
          sequence: 5,
          id: 'turn-error',
          type: 'observer.turn_ended',
          payload: { observer: { outcome: 'error' } },
          idempotencyKey: 'turn-error-event',
        }),
        event({
          sequence: 6,
          id: 'stall-suspected',
          type: 'observer.stall_suspected',
          payload: { observer: { silentForMs: 180_000 } },
          idempotencyKey: 'stall-suspected-event',
        }),
        event({
          sequence: 7,
          id: 'quota-failover',
          type: 'observer.provider_error',
          payload: { observer: { kind: 'quota' } },
          idempotencyKey: 'quota-failover-event',
        }),
        event({
          sequence: 8,
          id: 'rate-limit-failover',
          type: 'observer.provider_error',
          payload: { observer: { kind: 'rate-limit' } },
          idempotencyKey: 'rate-limit-failover-event',
        }),
        event({
          sequence: 9,
          id: 'auth-failover',
          type: 'observer.provider_error',
          payload: { observer: { kind: 'auth' } },
          idempotencyKey: 'auth-failover-event',
        }),
        event({
          sequence: 10,
          id: 'transient-failover',
          type: 'observer.provider_error',
          payload: { observer: { kind: 'transient' } },
          idempotencyKey: 'transient-failover-event',
        }),
      ],
    });
    const panel = selectTab(host, 'Atividade');
    const labels = Array.from(
      panel.querySelectorAll('li > span:last-child'),
      (item) => item.textContent?.trim(),
    );

    expect(labels).toEqual([
      'Controlador atualizou',
      'Controlador relatou uma falha',
      'Etapa 4 iniciada',
      'Etapa concluída',
      'A etapa terminou com erro',
      'Possível travamento: 3 min sem atividade',
      'Cota esgotada; rota alternativa acionada',
      'Limite de uso; rota alternativa acionada',
      'Credencial inválida; rota alternativa acionada',
      'Indisponibilidade temporária; rota alternativa acionada',
    ]);
    expect(panel.textContent).not.toMatch(/\b(?:Driver|Turn|stall|failover)\b/i);
  });

  it('projects the complete canonical team roster with each live state', () => {
    const host = mount();
    const panel = selectTab(host, 'Equipe');
    const text = panel.textContent ?? '';
    const lowerText = text.toLocaleLowerCase('pt-BR');

    for (const value of [
      'Coordenação principal',
      'agent-orchestrator',
      'orchestrator',
      'claude',
      'anthropic-subscription',
      'claude-opus-4-1',
      'high',
      'Líder de missão',
      'pane-orchestrator-full',
      'unit-review',
      'Coordene a missão e preserve as decisões do operador.',
      'Aguardando a decisão solicitada ao operador.',
      'Implementadora de interface sem abreviação',
      'agent-builder',
      'executor',
      'codex',
      'openai-subscription',
      'gpt-5.6-sol',
      'ultra',
      'Engenheira cuidadosa',
      'pane-builder-full',
      'unit-implementation',
      'Implemente os contratos observáveis e mantenha todo o texto acessível.',
      'Bloqueada somente pela escolha explícita do operador.',
      'Revisora final',
      'agent-reviewer',
      'reviewer',
      'agy',
      'antigravity-cli',
      'gemini-2.5-pro',
      'Revisora independente',
      'pane-reviewer-full',
      'Revise o resultado contra cada evidência canônica.',
      'Na fila até a implementação ser liberada.',
      'react-patterns',
      'a11y-debugging',
      'bmad-templates',
      'Read',
      'Edit',
      'Task',
    ]) {
      expect(lowerText).toContain(value.toLocaleLowerCase('pt-BR'));
    }
    expect(text).toMatch(/aguardando/i);
    expect(text).toMatch(/bloquead[ao]/i);
    expect(text).toMatch(/(na fila|enfileirad[ao])/i);
  });

  it('renders the complete canonical result including every evidence and artifact reference', () => {
    const host = mount({ snapshot: RESULT_SNAPSHOT, question: null });
    const panel = selectTab(host, 'Resultado');
    const text = panel.textContent ?? '';

    expect(text).toMatch(/parcial/i);
    expect(text).toContain(RESULT_SUMMARY);
    for (const value of [
      'evidence-contract-source',
      'evidence-rendered-board',
      'evidence-keyboard-path',
      'artifact://mission/report-completo.html',
      'artifact://mission/auditoria-acessibilidade.json',
    ]) {
      expect(text).toContain(value);
    }
  });

  it('makes a terminal mission without a persisted result explicit', () => {
    const host = mount({ snapshot: TERMINAL_WITHOUT_RESULT, question: null });
    const panel = selectTab(host, 'Resultado');
    const text = panel.textContent ?? '';

    expect(text).toMatch(/falh(ou|a)/i);
    expect(text).toMatch(/(sem resultado|resultado.*não.*persistid)/i);
    expect(text).not.toContain('artifact://mission/report-completo.html');
    expect(text).not.toContain('evidence-rendered-board');
  });

  it('F-244: colapsa eventos chef-idle consecutivos numa linha ×N', () => {
    const host = mount({
      events: [
        event({ sequence: 1, id: 'run', type: 'mission.run_started' }),
        event({
          sequence: 2, id: 'idle-1', type: 'custom',
          payload: { kind: 'chef_idle_awaiting_workers', workerCount: 1 },
          idempotencyKey: 'chef-idle-1',
        }),
        event({
          sequence: 3, id: 'idle-2', type: 'custom',
          payload: { kind: 'chef_idle_awaiting_workers', workerCount: 1 },
          idempotencyKey: 'chef-idle-2',
        }),
        event({
          sequence: 4, id: 'idle-3', type: 'custom',
          payload: { kind: 'chef_idle_awaiting_workers', workerCount: 1 },
          idempotencyKey: 'chef-idle-3',
        }),
      ],
    });
    const panel = selectTab(host, 'Atividade');
    const items = Array.from(panel.querySelectorAll('li'));

    expect(items).toHaveLength(2);
    expect(items[1]?.textContent).toContain(
      'Coordenador ocioso aguardando 1 worker(s)',
    );
    expect(items[1]?.textContent).toContain('×3');
  });

  it('F-244: pane-final-screen vira details com a cauda como texto puro', () => {
    const host = mount({
      events: [
        event({
          sequence: 1, id: 'screen-1', type: 'custom',
          payload: {
            kind: 'pane-final-screen',
            paneId: 'pane-32',
            sessionId: 'pty-32',
            role: 'worker',
            adapterId: 'glm',
            agentName: 'Construtor',
            tail: '$ read foo.ts\n<img src=x onerror=alert(1)> fim',
          },
          idempotencyKey: 'pane_final_screen:pty-32',
        }),
      ],
    });
    const panel = selectTab(host, 'Atividade');
    const details = panel.querySelector('details');
    const summary = details?.querySelector('summary');

    expect(summary?.textContent).toContain('Última tela — Construtor (worker)');
    const pre = details?.querySelector('pre.mission-inspector__final-screen');
    expect(pre?.textContent).toContain('$ read foo.ts');
    // Cauda é texto React, nunca markup: o <img> aparece como texto literal.
    expect(pre?.querySelector('img')).toBeNull();
    expect(pre?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('F-244: kind custom desconhecido vira "Evento <kind>" sem quebrar', () => {
    const host = mount({
      events: [
        event({
          sequence: 1, id: 'mystery', type: 'custom',
          payload: { kind: 'wat-futuro' },
          idempotencyKey: 'mystery-kind',
        }),
        event({
          sequence: 2, id: 'bad-kind', type: 'custom',
          payload: { kind: '<script>alert(1)</script>' },
          idempotencyKey: 'bad-kind-xx',
        }),
      ],
    });
    const panel = selectTab(host, 'Atividade');

    expect(panel.textContent).toContain('Evento wat-futuro');
    expect(panel.textContent).toContain('Evento personalizado registrado');
    expect(panel.querySelector('script')).toBeNull();
  });

  it('F-244: cauda maior que 4 KB fica limitada', () => {
    const host = mount({
      events: [
        event({
          sequence: 1, id: 'screen-big', type: 'custom',
          payload: {
            kind: 'pane-final-screen',
            paneId: 'pane-1',
            sessionId: 'pty-1',
            role: 'worker',
            adapterId: 'glm',
            tail: 'x'.repeat(9_000),
          },
          idempotencyKey: 'pane_final_screen:pty-1',
        }),
      ],
    });
    const panel = selectTab(host, 'Atividade');
    const pre = panel.querySelector('pre.mission-inspector__final-screen');

    expect(pre?.textContent?.length).toBeLessThanOrEqual(4 * 1024);
  });

  it('F-244: missão blocked_technical abre Atividade com "Por que parou"', () => {
    const blockedSnapshot = missionSnapshotSchema.parse({
      ...SNAPSHOT,
      state: 'blocked_technical',
      stateReason: {
        code: 'mission-blocked',
        label: 'O coordenador ficou ocioso esperando a equipe e o Nexus pausou a missão.',
        detail: 'Veja a última tela de cada pane na aba Atividade.',
      },
      allowedActions: ['retry-kickoff', 'stop'],
    });
    const host = mount({
      snapshot: blockedSnapshot,
      events: [
        event({
          sequence: 1, id: 'screen-old', type: 'custom',
          payload: {
            kind: 'pane-final-screen', paneId: 'pane-a',
            sessionId: 'pty-a', role: 'worker', adapterId: 'glm',
            tail: 'tela antiga',
          },
          idempotencyKey: 'pane_final_screen:pty-a',
        }),
        event({
          sequence: 2, id: 'screen-new', type: 'custom',
          payload: {
            kind: 'pane-final-screen', paneId: 'pane-b',
            sessionId: 'pty-b', role: 'orchestrator', adapterId: 'claude',
            agentName: 'Maestro',
            tail: 'tela recente',
          },
          idempotencyKey: 'pane_final_screen:pty-b',
        }),
      ],
    });
    const panel = selectTab(host, 'Atividade');
    const section = panel.querySelector('.mission-inspector__stop-reason');

    expect(section?.textContent).toContain('Por que parou');
    expect(section?.textContent).toContain('coordenador ficou ocioso');
    const summaries = Array.from(
      section?.querySelectorAll('summary') ?? [],
      (node) => node.textContent,
    );
    // Mais recente primeiro.
    expect(summaries[0]).toContain('Maestro');
    expect(summaries[1]).toContain('glm');
    expect(section?.textContent).toContain('tela recente');
  });

  it('F-244: bloqueio sem tela gravada diz isso explicitamente', () => {
    const blockedSnapshot = missionSnapshotSchema.parse({
      ...SNAPSHOT,
      state: 'blocked_technical',
      stateReason: { code: 'mission-blocked', label: 'Motivo não registrado.' },
      allowedActions: ['retry-kickoff', 'stop'],
    });
    const host = mount({ snapshot: blockedSnapshot });
    const panel = selectTab(host, 'Atividade');

    expect(panel.textContent).toContain('Por que parou');
    expect(panel.textContent).toContain(
      'Sem última tela registrada (a missão foi encerrada por uma build anterior)',
    );
  });
});

describe('F-1005 — atividade diz quanto falta e carrega mais pelo Main', () => {
  function mountWithJournal(journal: {
    total: number | null;
    hasMore: boolean;
    loading: boolean;
    onLoadMore: () => void;
  }): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.add(root);
    act(() => {
      root.render(
        <MissionInspector
          snapshot={SNAPSHOT}
          events={ACTIVITY_EVENTS}
          onCommand={vi.fn(async () => SNAPSHOT)}
          question={null}
          journal={journal}
        />,
      );
    });
    return host;
  }

  it('mostra "N de total" e o botão chama a paginação', () => {
    const onLoadMore = vi.fn();
    const host = mountWithJournal({ total: 90, hasMore: true, loading: false, onLoadMore });
    const panel = selectTab(host, 'Atividade');

    expect(panel.textContent).toContain('Mostrando os 3 eventos mais recentes de 90');
    const button = Array.from(panel.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Carregar eventos anteriores',
    );
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('sem histórico anterior não oferece o botão', () => {
    const host = mountWithJournal({ total: 3, hasMore: false, loading: false, onLoadMore: vi.fn() });
    const panel = selectTab(host, 'Atividade');

    expect(panel.textContent).not.toContain('Carregar eventos anteriores');
    expect(panel.textContent).not.toContain('mais recentes de');
  });
});
