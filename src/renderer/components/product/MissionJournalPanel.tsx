/**
 * Contextual-panel Mission tab: consume mission_events journal (recent + ACK).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { missionEventSchema, type MissionEvent } from '../../../shared/mission-events';
import { useOrchStore } from '../../state/orch-store';
import { useToastStore } from '../../state/toast-store';

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
      setError('Journal API unavailable');
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
      setError(err instanceof Error ? err.message : 'load failed');
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
        pushToast('warn', 'Journal ACK', result.error ?? 'ack failed');
        return;
      }
      pushToast('success', 'Journal', `ACK até seq ${maxSeq}`);
      await refresh();
    } catch (err) {
      pushToast(
        'warn',
        'Journal ACK',
        err instanceof Error ? err.message : 'ack failed',
      );
    }
  };

  if (sortedMissions.length === 0) {
    return (
      <div className="product-pane" data-testid="mission-journal-empty">
        <p className="product-pane__meta">
          Nenhuma missão neste workspace. Arme uma missão para ver o journal.
        </p>
      </div>
    );
  }

  return (
    <div className="product-pane" data-testid="mission-journal">
      <div className="product-pane__form product-pane__form--row">
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
        >
          ACK
        </button>
      </div>
      {!enabled && (
        <p className="product-pane__meta">
          Journal desligado (feature.mission.eventJournal).
        </p>
      )}
      {error && <p className="product-pane__error">{error}</p>}
      <p className="product-pane__meta">
        Cursor {CONSUMER_ID}: seq ≤ {cursorSeq}
      </p>
      <ul className="product-pane__list mission-journal__list">
        {[...events].reverse().map((ev) => {
          const unread = ev.sequence > cursorSeq;
          return (
            <li
              key={ev.id}
              className={`product-pane__item${unread ? ' mission-journal__item--unread' : ''}`}
            >
              <span className="product-pane__sub">
                #{ev.sequence} · {ev.type} · {ev.origin}
              </span>
              <strong className="mission-journal__type">{ev.deliveryStatus}</strong>
              <p className="product-pane__snip">
                {formatTime(ev.occurredAt)} · run {ev.runId.slice(0, 12)}
                {ev.payload && Object.keys(ev.payload).length > 0
                  ? ` · ${JSON.stringify(ev.payload).slice(0, 120)}`
                  : ''}
              </p>
            </li>
          );
        })}
      </ul>
      {enabled && events.length === 0 && !busy && (
        <p className="product-pane__meta">
          Sem eventos ainda. O driver grava ticks quando a missão roda.
        </p>
      )}
    </div>
  );
}
