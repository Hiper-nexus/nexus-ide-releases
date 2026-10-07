// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só o uso do
// LegendList de MessagesTimeline.tsx (data/extraData/keyExtractor/renderItem,
// estimatedItemSize, maintainScrollAtEnd suspenso durante a expansão de um
// detalhe, MVCP); a lista abre no topo como antes (sem initialScrollAtEnd nem
// memória de posição) e remonta por missão+filtro; parse, filtros, cards e
// teclado continuam os do Nexus.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LegendList } from '@legendapp/list/react';
import type { MissionEvent } from '../../../shared/mission-events';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import {
  ACTIVITY_TIMELINE_FOLLOW_THRESHOLD,
  ACTIVITY_TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION,
  createActivityScopeKey,
  resolveMaintainScrollAtEnd,
  scheduleDisclosureSettle,
} from '../../lib/activity-timeline-scroll';

export type ActivityCategory = 'all' | 'tools' | 'turns' | 'decisions';

export type ToolKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'plan' | 'task' | 'generic';

export interface TimelineItemModel {
  readonly id: string;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly category: 'tool' | 'turn' | 'decision' | 'status' | 'system';
  readonly kind: ToolKind;
  readonly title: string;
  readonly subtitle?: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly detail?: string;
  readonly icon: PixelIconName;
}

function classifyToolKind(toolName: string): { kind: ToolKind; label: string; icon: PixelIconName } {
  const normalized = toolName.toLowerCase();
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('terminal') || normalized.includes('exec')) {
    return { kind: 'shell', label: 'Shell', icon: 'terminal' };
  }
  if (normalized.includes('read') || normalized.includes('view') || normalized.includes('cat')) {
    return { kind: 'read', label: 'Leitura', icon: 'file' };
  }
  if (normalized.includes('edit') || normalized.includes('replace') || normalized.includes('patch')) {
    return { kind: 'edit', label: 'Edição', icon: 'sparkle' };
  }
  if (normalized.includes('write') || normalized.includes('create') || normalized.includes('save')) {
    return { kind: 'write', label: 'Escrita', icon: 'files' };
  }
  if (normalized.includes('grep') || normalized.includes('search') || normalized.includes('find')) {
    return { kind: 'search', label: 'Busca', icon: 'search' };
  }
  if (normalized.includes('plan') || normalized.includes('todo')) {
    return { kind: 'plan', label: 'Plano', icon: 'check' };
  }
  return { kind: 'generic', label: toolName || 'Ferramenta', icon: 'config' };
}

function stringifyPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const output = p.output ?? p.result ?? p.stdout ?? p.content ?? p.error ?? p.reason;
  if (typeof output === 'string' && output.trim()) return output.trim();
  if (output && typeof output === 'object') {
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }
  return undefined;
}

export function parseTimelineItems(events: readonly MissionEvent[], missionId: string): TimelineItemModel[] {
  const items: TimelineItemModel[] = [];

  for (const event of events) {
    if (event.missionId !== missionId) continue;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const detail = stringifyPayload(p);

    switch (event.type) {
      case 'tool.invoked':
      case 'observer.tool_call': {
        const rawName = String(p.toolName ?? p.name ?? 'Ferramenta');
        const classification = classifyToolKind(rawName);
        const command = typeof p.command === 'string' ? p.command : (typeof p.input === 'string' ? p.input : undefined);
        const filePath = typeof p.filePath === 'string' ? p.filePath : (typeof p.path === 'string' ? p.path : undefined);
        const query = typeof p.query === 'string' ? p.query : undefined;

        items.push({
          id: event.id,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          category: 'tool',
          kind: classification.kind,
          title: classification.label,
          subtitle: command || filePath || query || (typeof p.toolInput === 'string' ? p.toolInput : undefined),
          status: 'running',
          detail,
          icon: classification.icon,
        });
        break;
      }

      case 'tool.completed':
      case 'observer.tool_result': {
        const rawName = String(p.toolName ?? p.name ?? 'Ferramenta');
        const classification = classifyToolKind(rawName);
        const isOk = p.ok !== false && !p.error;

        items.push({
          id: event.id,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          category: 'tool',
          kind: classification.kind,
          title: classification.label,
          subtitle: isOk ? 'Concluída com sucesso' : 'Falha na execução',
          status: isOk ? 'completed' : 'failed',
          detail,
          icon: classification.icon,
        });
        break;
      }

      case 'observer.turn_started':
        items.push({
          id: event.id,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          category: 'turn',
          kind: 'generic',
          title: `Etapa ${p.turnSequence ?? ''}`.trim(),
          subtitle: 'Iniciando raciocínio e execução',
          status: 'running',
          detail,
          icon: 'status-busy',
        });
        break;

      case 'observer.turn_ended':
        items.push({
          id: event.id,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          category: 'turn',
          kind: 'generic',
          title: 'Etapa concluída',
          subtitle: p.outcome === 'error' ? 'Terminou com erro' : 'Ações da etapa finalizadas',
          status: p.outcome === 'error' ? 'failed' : 'completed',
          detail,
          icon: 'check',
        });
        break;

      case 'agent.needs_input':
        items.push({
          id: event.id,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          category: 'decision',
          kind: 'task',
          title: 'Decisão do operador solicitada',
          subtitle: typeof p.prompt === 'string' ? p.prompt : 'O agente está aguardando instruções',
          status: 'running',
          detail,
          icon: 'user',
        });
        break;

      case 'observer.status_changed':
        items.push({
          id: event.id,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          category: 'status',
          kind: 'generic',
          title: `Estado: ${String(p.status ?? 'atualizado')}`,
          status: p.status === 'error' ? 'failed' : (p.status === 'completed' ? 'completed' : 'running'),
          detail,
          icon: 'status-busy',
        });
        break;

      default:
        // Outros eventos operacionais
        items.push({
          id: event.id,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          category: 'system',
          kind: 'generic',
          title: event.type.replace(/[._]/g, ' '),
          status: 'completed',
          detail,
          icon: 'status-idle',
        });
        break;
    }
  }

  return items.sort((a, b) => a.sequence - b.sequence);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Card fechado medido no Chromium: 40 px + 8 px de padding-bottom do item. O
// Legend troca pela média medida assim que as primeiras linhas montam.
const TIMELINE_ESTIMATED_ITEM_SIZE = 48;

function timelineKeyExtractor(item: TimelineItemModel): string {
  return item.id;
}

const TimelineRow = memo(function TimelineRow({
  item,
  expanded,
  onToggle,
}: {
  readonly item: TimelineItemModel;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
}) {
  const hasDetail = Boolean(item.detail);

  return (
    <div
      className={`agent-timeline__item agent-timeline__item--${item.status} agent-timeline__item--${item.kind}`}
      role="listitem"
    >
      <div
        className={`agent-timeline__card${hasDetail ? ' is-clickable' : ''}`}
        onClick={hasDetail ? () => onToggle(item.id) : undefined}
        onKeyDown={
          hasDetail
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(item.id);
                }
              }
            : undefined
        }
        role={hasDetail ? 'button' : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        <div className="agent-timeline__header">
          <span className={`agent-timeline__indicator agent-timeline__indicator--${item.status}`}>
            <PixelIcon name={item.icon} size={12} />
          </span>

          <div className="agent-timeline__meta">
            <div className="agent-timeline__title-row">
              <span className="agent-timeline__kind-badge">{item.title}</span>
              {item.subtitle && (
                <span className="agent-timeline__subtitle" title={item.subtitle}>
                  {item.subtitle}
                </span>
              )}
            </div>
          </div>

          <span className="agent-timeline__sequence">#{item.sequence}</span>

          {hasDetail && (
            <span className={`agent-timeline__chevron${expanded ? ' is-open' : ''}`}>
              <PixelIcon name="chevron-down" size={10} />
            </span>
          )}
        </div>

        {hasDetail && expanded && (
          <div className="agent-timeline__detail">
            <pre className="agent-timeline__pre">{item.detail}</pre>
          </div>
        )}
      </div>
    </div>
  );
});

export function AgentActivityTimeline({
  events,
  missionId,
}: {
  readonly events: readonly MissionEvent[];
  readonly missionId: string;
}) {
  const [filter, setFilter] = useState<ActivityCategory>('all');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  // Enquanto um detalhe abre/fecha, o follow do fim fica suspenso (2 frames).
  const [disclosureSettling, setDisclosureSettling] = useState(false);
  const cancelDisclosureSettleRef = useRef<(() => void) | null>(null);

  const allItems = useMemo(() => parseTimelineItems(events, missionId), [events, missionId]);

  const filteredItems = useMemo(() => {
    if (filter === 'all') return allItems;
    if (filter === 'tools') return allItems.filter((i) => i.category === 'tool');
    if (filter === 'turns') return allItems.filter((i) => i.category === 'turn');
    if (filter === 'decisions') return allItems.filter((i) => i.category === 'decision');
    return allItems;
  }, [allItems, filter]);

  const counts = useMemo(
    () => ({
      tools: allItems.filter((i) => i.category === 'tool').length,
      turns: allItems.filter((i) => i.category === 'turn').length,
      decisions: allItems.filter((i) => i.category === 'decision').length,
    }),
    [allItems],
  );

  // A key da lista: trocar de missão ou filtro remonta o Legend sem herdar
  // âncora, offset ou follow do escopo anterior. A expansão dos cards é estado
  // deste componente e sobrevive à troca de filtro, como antes da virtualização.
  const scopeKey = createActivityScopeKey(missionId, filter);

  useEffect(() => () => cancelDisclosureSettleRef.current?.(), []);

  const toggleExpanded = useCallback((id: string) => {
    cancelDisclosureSettleRef.current?.();
    setDisclosureSettling(true);
    cancelDisclosureSettleRef.current = scheduleDisclosureSettle(() => {
      cancelDisclosureSettleRef.current = null;
      setDisclosureSettling(false);
    });
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const renderItem = useCallback(
    ({ item }: { readonly item: TimelineItemModel }) => (
      <TimelineRow item={item} expanded={Boolean(expandedIds[item.id])} onToggle={toggleExpanded} />
    ),
    [expandedIds, toggleExpanded],
  );

  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  if (allItems.length === 0) {
    return (
      <p className="mission-inspector__empty" role="status">
        Nenhuma atividade canônica segura foi registrada ainda.
      </p>
    );
  }

  return (
    <div className="agent-timeline">
      <div className="agent-timeline__filters" role="tablist" aria-label="Filtro de atividade">
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'all'}
          className={`agent-timeline__filter-btn${filter === 'all' ? ' is-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          Todas ({allItems.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'tools'}
          className={`agent-timeline__filter-btn${filter === 'tools' ? ' is-active' : ''}`}
          onClick={() => setFilter('tools')}
        >
          Ferramentas ({counts.tools})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'turns'}
          className={`agent-timeline__filter-btn${filter === 'turns' ? ' is-active' : ''}`}
          onClick={() => setFilter('turns')}
        >
          Etapas ({counts.turns})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'decisions'}
          className={`agent-timeline__filter-btn${filter === 'decisions' ? ' is-active' : ''}`}
          onClick={() => setFilter('decisions')}
        >
          Decisões ({counts.decisions})
        </button>
      </div>

      <LegendList<TimelineItemModel>
        key={scopeKey}
        data={filteredItems}
        // Linhas visíveis re-renderizam quando um card abre/fecha.
        extraData={expandedIds}
        keyExtractor={timelineKeyExtractor}
        renderItem={renderItem}
        estimatedItemSize={TIMELINE_ESTIMATED_ITEM_SIZE}
        // Contêiner reaproveitado remonta a linha: o card focado nunca passa a
        // mostrar outro evento.
        recycleItems={false}
        // Sem initialScrollIndex/initialScrollAtEnd: abre no topo, como antes.
        // O stream só puxa a lista se ela já estava no fim (banda do Legend).
        maintainScrollAtEnd={resolveMaintainScrollAtEnd({ disclosureSettling, reducedMotion })}
        maintainScrollAtEndThreshold={ACTIVITY_TIMELINE_FOLLOW_THRESHOLD}
        maintainVisibleContentPosition={ACTIVITY_TIMELINE_MAINTAIN_VISIBLE_CONTENT_POSITION}
        className="agent-timeline__list"
        role="list"
      />
    </div>
  );
}
