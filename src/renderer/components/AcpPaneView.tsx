import { useEffect, useMemo, useState } from 'react';
import { missionEventSchema, type MissionEvent } from '../../shared/mission-events';

interface Props {
  missionId: string;
  compact?: boolean;
}

function parseEvents(raw: unknown[]): MissionEvent[] {
  return raw.flatMap((value) => {
    try {
      return [missionEventSchema.parse(value)];
    } catch {
      return [];
    }
  });
}

function eventText(event: MissionEvent): string {
  const observer = event.payload.observer;
  const payload =
    observer && typeof observer === 'object' && !Array.isArray(observer)
      ? (observer as Record<string, unknown>)
      : null;
  if (!payload) {
    if (event.type === 'handoff.submitted') return 'Entrega registrada';
    if (event.type === 'driver.error') return 'Driver reportou um erro';
    return 'Atividade registrada na missão';
  }
  switch (event.type) {
    case 'observer.turn_started':
      return `Turn ${String(payload.turnSequence ?? '?')} iniciado`;
    case 'observer.turn_ended':
      return payload.outcome === 'completed'
        ? 'Turn concluído'
        : 'Turn terminou com erro';
    case 'observer.tool_call':
      return `Ferramenta ${String(payload.toolName ?? 'desconhecida')} acionada`;
    case 'observer.tool_result':
      return `${String(payload.toolName ?? 'Ferramenta')} ${payload.ok === true ? 'concluída' : 'falhou'}`;
    case 'observer.status_changed':
      return `Status: ${String(payload.status ?? 'desconhecido')}`;
    case 'observer.session_spawned':
      return 'Sessão ACP iniciada';
    case 'observer.session_exited':
      return 'Sessão ACP encerrada';
    case 'observer.provider_error':
      return `Provider: ${String(payload.kind ?? 'erro')}`;
    default:
      return 'Atividade do agente';
  }
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Typed ACP activity surface. It intentionally has no terminal input. */
export function AcpPaneView({ missionId, compact = false }: Props) {
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useMemo(() => events.slice(-8).reverse(), [events]);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await window.nexus.orch.missionEventsRecent({
          missionId,
          limit: compact ? 12 : 32,
        });
        if (disposed) return;
        setEvents(parseEvents(result.events ?? []));
        setError(result.error ?? null);
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : 'timeline indisponível');
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), compact ? 2_000 : 1_200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [compact, missionId]);

  return (
    <section className={`acp-pane${compact ? ' acp-pane--compact' : ''}`} aria-label="Atividade ACP">
      <div className="acp-pane__summary">
        <span className="acp-pane__pulse" aria-hidden="true" />
        <div>
          <strong>Atividade estruturada</strong>
          <span>ACP / JSON-RPC · sem leitura de scrollback</span>
        </div>
      </div>
      {error && (
        <p className="acp-pane__error" role="alert">
          {error}
        </p>
      )}
      {latest.length > 0 ? (
        <ol className="acp-pane__events">
          {latest.map((event) => (
            <li key={event.id}>
              <span>{timeLabel(event.occurredAt)}</span>
              <strong>{eventText(event)}</strong>
            </li>
          ))}
        </ol>
      ) : (
        <p className="acp-pane__empty">Aguardando o primeiro evento do agente.</p>
      )}
    </section>
  );
}
