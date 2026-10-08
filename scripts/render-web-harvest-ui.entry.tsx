// Cenas do harness visual WEB-12/13/17 (scripts/render-web-harvest-ui.mjs).
// Renderiza os componentes REAIS do renderer com o CSS real (global.css) e
// dados sintéticos; nenhuma IPC, nenhum perfil do operador, nenhuma CLI.
import { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UsageQuotaSection } from '../src/renderer/components/settings/UsageQuotaSection';
import { UsageHistoryChart } from '../src/renderer/components/settings/UsageHistoryChart';
import {
  AgentActivityTimeline,
  type TimelineItemModel,
} from '../src/renderer/components/mission/AgentActivityTimeline';
import { DirectionComposer } from '../src/renderer/components/mission/DirectionComposer';
import { WorkspaceTabs } from '../src/renderer/components/product/WorkspaceTabs';
import { formatQuote, type QuoteDraft, type QuoteOrigin } from '../src/renderer/lib/quote-reference';
import { applyTabOrder, moveTabKey } from '../src/renderer/lib/tab-drag';
import type { PaneScopeEntry } from '../src/renderer/lib/pane-spaces';
import type { MissionEvent } from '../src/shared/mission-events';
import type { MissionAgentSnapshot, MissionSnapshot } from '../src/shared/mission-engine-contract';
import '../src/renderer/styles/global.css';

const scene = new URLSearchParams(location.search).get('scene') ?? 'usage-ready';
const NOW = Date.now();

function dayKey(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const HISTORY_DAYS = [
  [27, 180_000, 0.42, 4], [25, 640_000, 1.6, 11], [24, 910_000, 2.3, 15], [22, 120_000, 0.3, 2],
  [20, 1_450_000, 3.9, 22], [19, 1_820_000, 4.7, 30], [18, 760_000, 1.9, 12], [15, 300_000, 0.8, 5],
  [13, 2_400_000, 6.1, 41], [12, 2_050_000, 5.2, 33], [11, 980_000, 2.5, 17], [8, 450_000, 1.1, 8],
  [6, 1_300_000, 3.3, 21], [5, 1_700_000, 4.4, 26], [4, 640_000, 1.6, 10], [2, 2_900_000, 7.4, 48],
  [1, 1_150_000, 2.9, 19], [0, 420_000, 1.05, 7],
].map(([offset, tokens, usd, turns]) => ({
  day: dayKey(offset as number),
  tokens: tokens as number,
  usdEquivalent: usd as number,
  turns: turns as number,
}));
const HISTORY = { since: NOW - 60 * 86_400_000, updatedAt: NOW, days: HISTORY_DAYS };

function installUsageBridge(): void {
  const quota = {
    updatedAt: NOW,
    worstUsedRatio: 0.62,
    highUsageCount: 0,
    unknownCount: 0,
    entries: [
      {
        id: 'claude',
        adapterId: 'claude',
        label: 'Claude · CLI nativo',
        installed: true,
        onCooldown: false,
        updatedAt: NOW,
        windows: [
          { kind: 'hours', label: '5 Horas', usedRatio: 0.62, source: 'provider-api', confidence: 'high', resetsAt: NOW + 2 * 3_600_000 },
          { kind: 'weekly', label: 'Semanal', usedRatio: 0.31, source: 'provider-api', confidence: 'high', resetsAt: NOW + 3 * 86_400_000 },
        ],
      },
    ],
  };
  (window as unknown as { nexus: unknown }).nexus = {
    quota: { snapshot: async () => quota, refresh: async () => quota, onChanged: () => () => {} },
    usage: {
      lifetime: async () => ({ tokensBurned: 48_200_000, usdEquivalent: 121.4, panesServed: 86, turns: 912 }),
      history: async () => HISTORY,
      onChanged: () => () => {},
    },
  };
}

function markReady(): void {
  document.body.dataset.ready = '1';
}

function after(ms: number, run: () => void): void {
  setTimeout(run, ms);
}

// ---------------------------------------------------------------- WEB-12 ---

function UsageScene() {
  return (
    <div className="harness-settings">
      <UsageQuotaSection />
    </div>
  );
}

function ChartStates() {
  return (
    <div className="harness-settings harness-stack">
      <UsageHistoryChart status="loading" history={null} now={NOW} onRetry={() => {}} />
      <UsageHistoryChart status="error" history={null} now={NOW} onRetry={() => {}} />
      <UsageHistoryChart status="ready" history={{ ...HISTORY, days: [], since: NOW - 3 * 86_400_000 }} now={NOW} onRetry={() => {}} />
    </div>
  );
}

// ---------------------------------------------------------------- WEB-17 ---

const MISSION_ID = 'mission-harness';
const AGENTS: MissionAgentSnapshot[] = [
  {
    id: 'executor', agentName: 'Implementar interface', category: 'executor', cli: 'codex',
    model: 'gpt-5.6', effort: 'high', allowedSkills: [], allowedTools: ['Read', 'Edit'], state: 'working', paneId: 'pane-codex',
  },
  {
    id: 'reviewer', agentName: 'Revisar entrega', category: 'reviewer', cli: 'claude',
    model: 'claude-opus', effort: 'high', allowedSkills: [], allowedTools: ['Read'], state: 'waiting', paneId: 'pane-claude',
  },
];
const EVENTS: MissionEvent[] = [
  ['observer.turn_started', { turnSequence: 3, paneId: 'pane-codex' }],
  ['observer.tool_call', { toolName: 'bash', command: 'npx vitest run src/renderer/lib/quote-reference.test.ts', paneId: 'pane-codex' }],
  ['observer.tool_result', { toolName: 'bash', ok: false, output: 'FAIL quote-reference.test.ts > parseQuoteOrigins\nExpected sequence 17, received 71', paneId: 'pane-codex' }],
  ['observer.tool_call', { toolName: 'edit', path: 'src/renderer/lib/quote-reference.ts', paneId: 'pane-codex' }],
  ['observer.tool_result', { toolName: 'bash', ok: true, output: '6 passed (6)', paneId: 'pane-codex' }],
  ['agent.needs_input', { prompt: 'Posso abrir o PR com as duas correções?', paneId: 'pane-claude' }],
].map(([type, payload], index) => ({
  id: `evt-${index + 40}`,
  sequence: index + 40,
  missionId: MISSION_ID,
  runId: 'observer:harness',
  origin: 'main',
  deliveryStatus: 'delivered',
  type: type as MissionEvent['type'],
  payload: payload as Record<string, unknown>,
  idempotencyKey: `harness-${index}-idempotency`,
  occurredAt: NOW - (10 - index) * 60_000,
}));
const SNAPSHOT = {
  id: MISSION_ID, title: 'Citar resposta', objective: 'Harness', workspaceLabel: 'nexus', state: 'running',
  progress: { completed: 1, total: 3 }, agents: AGENTS, edges: [], units: [], allowedActions: ['direct'],
  version: 1, updatedAt: NOW,
} as unknown as MissionSnapshot;

function QuoteScene({ autoQuote }: { readonly autoQuote: boolean }) {
  const [quote, setQuote] = useState<QuoteDraft | null>(null);
  const nonce = useRef(0);
  const onQuote = useCallback((item: TimelineItemModel) => {
    const agent = AGENTS.find((candidate) => candidate.paneId === item.paneId);
    const origin: QuoteOrigin = {
      missionId: MISSION_ID, eventId: item.id, sequence: item.sequence,
      ...(item.runId ? { runId: item.runId } : {}),
      ...(item.paneId ? { paneId: item.paneId } : {}),
      ...(agent ? { agentName: agent.agentName } : {}),
    };
    nonce.current += 1;
    setQuote({
      origin,
      text: formatQuote(origin, item.title, [item.subtitle, item.detail].filter(Boolean).join('\n') || item.title),
      nonce: nonce.current,
    });
  }, []);
  if (autoQuote) {
    after(400, () => {
      const buttons = document.querySelectorAll<HTMLButtonElement>('.agent-timeline__quote');
      buttons[2]?.click();
      after(300, markReady);
    });
  }
  return (
    <div className="harness-mission">
      <div className="mission-inspector harness-inspector">
        <div className="mission-inspector__activity-wrap mission-inspector__activity-wrap--timeline">
          <AgentActivityTimeline events={EVENTS} missionId={MISSION_ID} onQuote={onQuote} />
        </div>
      </div>
      <div className="mission-board__direct-bar">
        <DirectionComposer
          missionId={MISSION_ID}
          agents={AGENTS}
          onCommand={async () => SNAPSHOT}
          quote={quote}
          onQuoteConsumed={(consumed) => setQuote((current) => (current?.nonce === consumed ? null : current))}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- WEB-13 ---

const SCOPES: PaneScopeEntry[] = [
  { key: 'space:checkout', kind: 'space', id: 'checkout', title: 'Checkout', paneCount: 2, missions: [], orchestrator: null },
  {
    key: 'mission:epic', kind: 'mission', id: 'epic', title: 'Fechar o Epic 22', paneCount: 4, state: 'running',
    missions: [{ id: 'epic', title: 'Fechar o Epic 22', state: 'running' }], orchestrator: { paneId: 'orq', title: 'Claude' },
  },
  { key: 'space:docs', kind: 'space', id: 'docs', title: 'Docs do release', paneCount: 1, missions: [], orchestrator: null },
  { key: '__loose__', kind: 'loose', title: 'Terminais', paneCount: 3, missions: [], orchestrator: null },
];

function TabsScene() {
  const [order, setOrder] = useState<string[]>([]);
  const scopes = applyTabOrder(SCOPES, order);
  const noop = () => {};
  return (
    <div className="harness-tabs terminal-workspace">
      <WorkspaceTabs
        scopes={scopes}
        activeScopeKey="space:checkout"
        sideScopeKey={null}
        overview={false}
        editing={null}
        onFocusScope={noop}
        onToggleOverview={noop}
        onToggleBeside={noop}
        onCloseBeside={noop}
        onStartRename={noop}
        onRenameDraft={noop}
        onCommitRename={noop}
        onCancelRename={noop}
        onCloseTab={noop}
        onTabPaneCreated={noop}
        onNewMission={noop}
        onMoveTab={(key, toIndex) => setOrder(moveTabKey(scopes.map((scope) => scope.key), key, toIndex))}
      />
      <p className="harness-caption" id="harness-order">{scopes.map((scope) => scope.title).join(' · ')}</p>
    </div>
  );
}

function dragOver(target: Element, type: string, transfer: DataTransfer, side: 'before' | 'after'): void {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: side === 'before' ? rect.left + 4 : rect.right - 4,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

function driveTabs(): void {
  const tabs = () => [...document.querySelectorAll('.workspace-tab')];
  if (scene === 'tabs-drop') {
    after(200, () => {
      const transfer = new DataTransfer();
      tabs()[0]!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      after(50, () => {
        dragOver(tabs()[2]!, 'dragover', transfer, 'after');
        after(150, markReady);
      });
    });
  } else if (scene === 'tabs-moved') {
    after(200, () => {
      const transfer = new DataTransfer();
      tabs()[0]!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      dragOver(tabs()[2]!, 'dragover', transfer, 'after');
      dragOver(tabs()[2]!, 'drop', transfer, 'after');
      after(100, () => {
        const focused = document.querySelector<HTMLButtonElement>('[role="tab"][data-scope-key="__loose__"]')!;
        focused.focus();
        focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true }));
        after(150, markReady);
      });
    });
  } else if (scene === 'tabs-menu') {
    after(200, () => {
      const target = tabs()[1]!;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 20, clientY: rect.bottom + 2 }));
      after(150, markReady);
    });
  } else {
    after(200, markReady);
  }
}

// ------------------------------------------------------------------ boot ---

installUsageBridge();
const root = createRoot(document.getElementById('root')!);
if (scene.startsWith('usage-')) {
  if (scene === 'usage-states') {
    root.render(<ChartStates />);
    after(300, markReady);
  } else {
    root.render(<UsageScene />);
    after(600, () => {
      const chart = document.querySelector<SVGSVGElement>('.usage-history__chart');
      chart?.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -16);
      if (scene === 'usage-hover' && chart) {
        chart.focus();
        for (let step = 0; step < 3; step += 1) {
          chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        }
      }
      if (scene === 'usage-usd') {
        [...document.querySelectorAll<HTMLButtonElement>('.usage-history__metric-btn')][1]?.click();
      }
      if (scene === 'usage-table') {
        const details = document.querySelector<HTMLDetailsElement>('.usage-history__table-wrap');
        if (details) details.open = true;
      }
      after(250, markReady);
    });
  }
} else if (scene.startsWith('quote-')) {
  root.render(<QuoteScene autoQuote={scene === 'quote-after'} />);
  if (scene !== 'quote-after') after(500, markReady);
} else {
  root.render(<TabsScene />);
  driveTabs();
}
