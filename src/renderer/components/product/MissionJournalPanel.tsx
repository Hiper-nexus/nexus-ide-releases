/**
 * Contextual-panel Mission tab: consume mission_events journal (recent + ACK).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { missionEventSchema, type MissionEvent } from '../../../shared/mission-events';
import { useOrchStore } from '../../state/orch-store';
import { useToastStore } from '../../state/toast-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { PixelIcon } from '../PixelIcon';

const CONSUMER_ID = 'ui-main';

function parseEvents(raw: unknown[]): MissionEvent[] {
  const out: MissionEvent[] = [];
  for (const item of raw) {
    try {
      out.push(missionEventSchema.parse(item));
    } catch {
      /* skip */
    }
  }
  return out;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

function observerPayload(event: MissionEvent): Record<string, unknown> | null {
  if (!event.type.startsWith('observer.')) return null;
  const value = event.payload.observer;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function observerSummary(event: MissionEvent): string | null {
  const payload = observerPayload(event);
  if (!payload) return null;
  switch (event.type) {
    case 'observer.turn_started':
      return `Turn ${String(payload.turnSequence ?? '?')} iniciado`;
    case 'observer.turn_ended':
      return payload.outcome === 'completed'
        ? 'Turn concluído'
        : 'Turn terminou com erro';
    case 'observer.tool_call':
      return `Ferramenta ${String(payload.toolName ?? 'não identificada')} chamada`;
    case 'observer.tool_result':
      return `${String(payload.toolName ?? 'Ferramenta')} ${payload.ok === true ? 'passou' : 'falhou'}`;
    case 'observer.status_changed':
      return `Status: ${
        {
          working: 'trabalhando',
          completed: 'concluído',
          'awaiting-input': 'aguardando você',
          idle: 'em espera',
          error: 'erro',
        }[String(payload.status)] ?? 'desconhecido'
      }`;
    case 'observer.session_spawned':
      return `Sessão ${String(payload.adapterId ?? 'agente')} iniciou`;
    case 'observer.session_exited':
      return 'Sessão encerrou';
    case 'observer.stall_suspected': {
      const silentForMs = Number(payload.silentForMs);
      const minutes = Number.isFinite(silentForMs)
        ? Math.max(0, Math.round(silentForMs / 60_000))
        : 0;
      return `Possível stall: ${minutes} min sem atividade`;
    }
    case 'observer.provider_error': {
      const kind =
        {
          quota: 'cota esgotada',
          'rate-limit': 'limite de uso',
          auth: 'credencial inválida',
          transient: 'indisponibilidade temporária',
        }[String(payload.kind)] ?? 'erro do provider';
      return `${kind} — failover acionado`;
    }
    default:
      return null;
  }
}

function eventLabel(type: MissionEvent['type']): string {
  const labels: Partial<Record<MissionEvent['type'], string>> = {
    'mission.created': 'Missão criada',
    'mission.status_changed': 'Status atualizado',
    'mission.intent_armed': 'Objetivo armado',
    'mission.run_started': 'Execução iniciada',
    'mission.run_finished': 'Execução encerrada',
    'agent.spawned': 'Agente iniciou',
    'agent.finished': 'Agente terminou',
    'agent.needs_input': 'Agente pediu decisão',
    'agent.reaped': 'Agente encerrado',
    'tool.invoked': 'Ferramenta acionada',
    'tool.completed': 'Ferramenta concluída',
    'tool.denied': 'Ferramenta bloqueada',
    'handoff.submitted': 'Entrega enviada',
    'handoff.acked': 'Entrega reconhecida',
    'budget.reserved': 'Orçamento reservado',
    'budget.released': 'Orçamento liberado',
    'driver.tick': 'Driver sinalizou',
    'driver.error': 'Driver reportou erro',
    'ui.projection': 'Timeline atualizada',
    'observer.turn_started': 'Turn iniciado',
    'observer.turn_ended': 'Turn encerrado',
    'observer.tool_call': 'Ferramenta acionada',
    'observer.tool_result': 'Resultado de ferramenta',
    'observer.status_changed': 'Status do agente',
    'observer.session_spawned': 'Sessão iniciada',
    'observer.session_exited': 'Sessão encerrou',
    'observer.stall_suspected': 'Possível stall',
    'observer.provider_error': 'Limite do provider detectado',
  };
  return labels[type] ?? 'Evento da missão';
}

export function MissionJournalPanel() {
  const missions = useOrchStore((s) => s.missions);
  const [missionId, setMissionId] = useState<string>('');
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [cursorSeq, setCursorSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const pushToast = useToastStore((s) => s.push);

  const sortedMissions = useMemo(
    () =>
      [...missions].sort(
        (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
      ),
    [missions],
  );

  useEffect(() => {
    if (!missionId && sortedMissions[0]?.id) {
      setMissionId(sortedMissions[0].id);
    }
  }, [missionId, sortedMissions]);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setEvents([]);
      return;
    }
    if (!window.nexus?.orch?.missionEventsRecent) {
      setError('A timeline da missão está indisponível nesta sessão.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const recent = await window.nexus.orch.missionEventsRecent({
        missionId,
        limit: 40,
      });
      if (recent.enabled === false) {
        setEnabled(false);
        setEvents([]);
        return;
      }
      setEnabled(true);
      if (recent.error) setError(recent.error);
      setEvents(parseEvents((recent.events as unknown[]) ?? []));
      const cur = await window.nexus.orch.missionEventsCursor({
        missionId,
        consumerId: CONSUMER_ID,
      });
      const last =
        cur.cursor &&
        typeof cur.cursor === 'object' &&
        cur.cursor !== null &&
        'lastSequence' in cur.cursor
          ? Number((cur.cursor as { lastSequence: number }).lastSequence)
          : 0;
      setCursorSeq(Number.isFinite(last) ? last : 0);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Não foi possível carregar a timeline: ${err.message}`
          : 'Não foi possível carregar a timeline.',
      );
    } finally {
      setBusy(false);
    }
  }, [missionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ackThroughLatest = async () => {
    if (!missionId || events.length === 0) return;
    const maxSeq = Math.max(...events.map((e) => e.sequence));
    try {
      const result = await window.nexus.orch.missionEventsAck({
        missionId,
        upToSequence: maxSeq,
        consumerId: CONSUMER_ID,
      });
      if (!result.ok) {
        pushToast('warn', 'Timeline', result.error ?? 'falha ao marcar como lido');
        return;
      }
      pushToast('success', 'Timeline', `Marcado como lido até #${maxSeq}`);
      await refresh();
    } catch (err) {
      pushToast(
        'warn',
        'Timeline',
        err instanceof Error ? err.message : 'falha ao marcar como lido',
      );
    }
  };

  if (sortedMissions.length === 0) {
    return (
      <div className="product-pane product-pane--empty-mission" data-testid="mission-journal-empty">
        <div className="product-empty-card">
          <PixelIcon name="terminal" size={32} />
          <h3>Diário da Missão</h3>
          <p className="product-pane__meta">
            Nenhuma missão neste workspace. Arme uma missão para ver o journal e acompanhar entregas em tempo real.
          </p>
          <button
            type="button"
            className="product-pane__btn product-pane__btn--primary"
            onClick={() => useProductNavigationStore.getState().openNewMission()}
          >
            + Armar Nova Missão
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="product-pane" data-testid="mission-journal">
      <div className="product-pane__form product-pane__form--row mission-journal__controls">
        <select
          className="product-pane__input"
          value={missionId}
          onChange={(e) => setMissionId(e.target.value)}
          aria-label="Missão"
        >
          {sortedMissions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title || m.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="product-pane__btn"
          onClick={() => useProductNavigationStore.getState().openNewMission()}
          title="Armar nova missão"
          aria-label="Nova missão"
        >
          +
        </button>
        <button
          type="button"
          className="product-pane__btn"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? '…' : 'Atualizar'}
        </button>
        <button
          type="button"
          className="product-pane__btn"
          disabled={!enabled || events.length === 0}
          onClick={() => void ackThroughLatest()}
          aria-label="Marcar eventos como lidos"
        >
          Marcar como lido
        </button>
      </div>
      <div className="mission-journal__intro">
        <div>
          <strong>Timeline da missão</strong>
          <span>Eventos persistentes, em ordem de execução.</span>
        </div>
        <span className="mission-journal__cursor">
          Lido até #{cursorSeq}
        </span>
      </div>
      {!enabled && (
        <p className="product-pane__meta">
          Journal desligado (feature.mission.eventJournal).
        </p>
      )}
      {error && <p className="product-pane__error">{error}</p>}
      <ul className="product-pane__list mission-journal__list">
        {[...events].reverse().map((ev) => {
          const unread = ev.sequence > cursorSeq;
          return (
            <li
              key={ev.id}
              className={`product-pane__item${unread ? ' mission-journal__item--unread' : ''}`}
            >
              <span className="product-pane__sub">
                #{ev.sequence} · {formatTime(ev.occurredAt)}
              </span>
              <strong className="mission-journal__type">
                {eventLabel(ev.type)}
              </strong>
              <p className="product-pane__snip">
                {observerSummary(ev) ??
                  (ev.deliveryStatus === 'failed'
                    ? 'A entrega do evento falhou; abra o diagnóstico para detalhes.'
                    : 'Evento registrado na trilha da missão.')}
              </p>
              <span className="mission-journal__technical">
                {ev.type} · {ev.origin} · run {ev.runId.slice(0, 12)}
              </span>
            </li>
          );
        })}
      </ul>
      {enabled && events.length === 0 && !busy && (
        <p className="product-pane__meta">
          Sem eventos ainda. A trilha aparece quando um agente iniciar.
        </p>
      )}
    </div>
  );
}
