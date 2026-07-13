import { useEffect, useMemo, useState } from 'react';
import type { PublicModelRankingEntry } from '../../../shared/eval-ranking-types';
import type { QuotaFleetSnapshot } from '../../../shared/quota-types';
import { useProviderStore } from '../../state/provider-store';
import { useQuotaStore } from '../../state/quota-store';
import {
  RADAR_AXES,
  SORT_LABELS,
  SORT_MISSION,
  type SortKey,
  costEfficiency,
  costLabel,
  formatEvalTime,
  gridRingPath,
  pickForDimension,
  pickValue,
  radarPoints,
  radarPolygon,
  scoreOf,
  scoreOrZero,
  sortEntries,
  sortEntriesWithQuota,
} from './ranking-view';

/**
 * Per-adapter free capacity 0..1 for ranking blend. Uses freest account of each
 * adapter; null = no known ratios (neutral weight in scoreWithQuota).
 */
function quotaAvailabilityByAdapter(
  snapshot: QuotaFleetSnapshot,
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const e of snapshot.entries) {
    let free: number | null;
    if (e.onCooldown) {
      free = 0;
    } else {
      let worst: number | null = null;
      for (const w of e.windows) {
        if (w.usedRatio === null) continue;
        if (worst === null || w.usedRatio > worst) worst = w.usedRatio;
      }
      free = worst === null ? null : Math.max(0, Math.min(1, 1 - worst));
    }
    const prev = map.get(e.adapterId);
    if (prev === undefined) {
      map.set(e.adapterId, free);
      continue;
    }
    // Prefer freer account when comparing known values; null loses to known free.
    if (free === null) continue;
    if (prev === null || free > prev) map.set(e.adapterId, free);
  }
  return map;
}

/**
 * Operational LLM ranking cockpit — race + radar + mission picks.
 * Same DTO as resources/model-ranking.json; scores feed auto-routing.
 */

function RaceChart({
  rows,
  sort,
  selectedId,
  installed,
  onSelect,
}: {
  rows: PublicModelRankingEntry[];
  sort: SortKey;
  selectedId: string | null;
  installed: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => scoreOrZero(r, sort)));

  return (
    <div className="rank-race" role="list" aria-label={`Corrida por ${SORT_LABELS[sort]}`}>
      {rows.map((entry, index) => {
        const score = scoreOf(entry, sort);
        const width = score === null ? 0 : (score / max) * 100;
        const live = installed.has(entry.adapterId);
        const active = entry.id === selectedId;
        return (
          <button
            key={entry.id}
            type="button"
            role="listitem"
            className={`rank-race__row ${active ? 'rank-race__row--active' : ''} ${live ? '' : 'rank-race__row--ghost'}`}
            onClick={() => onSelect(entry.id)}
            aria-pressed={active}
            title={
              live
                ? `Selecionar ${entry.modelId} (CLI ${entry.adapterId} detectada)`
                : `${entry.modelId} — CLI ${entry.adapterId} ausente nesta máquina`
            }
          >
            <span className="rank-race__place">#{index + 1}</span>
            <span className="rank-race__id">
              <strong>{entry.modelId}</strong>
              <span className="rank-race__adapter">
                {entry.adapterId}
                {live ? (
                  <span className="rank-race__live"> · live</span>
                ) : (
                  <span className="rank-race__missing"> · off-machine</span>
                )}
              </span>
            </span>
            <span className="rank-race__track" aria-hidden="true">
              <span
                className="rank-race__bar"
                style={{ width: `${width}%` }}
                data-cost={costLabel(entry)}
              />
              <span className="rank-race__ticks">
                <i /><i /><i /><i />
              </span>
            </span>
            <span className="rank-race__score">
              {score === null ? '—' : score}
              <span className="rank-race__eff" title="eficiência overall/custo">
                η{costEfficiency(entry)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RadarChart({
  entry,
  ghost,
}: {
  entry: PublicModelRankingEntry;
  ghost: PublicModelRankingEntry | null;
}) {
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const r = 88;
  const main = radarPoints(entry, cx, cy, r);
  const ghostPts = ghost && ghost.id !== entry.id ? radarPoints(ghost, cx, cy, r) : null;
  const rings = [0.25, 0.5, 0.75, 1];

  return (
    <div className="rank-radar">
      <svg
        className="rank-radar__svg"
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`Perfil multi-eixo de ${entry.modelId}`}
      >
        <defs>
          <radialGradient id="rank-radar-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="70%" stopColor="var(--accent)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="rank-poly-fill" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--ok, #5fd38d)" stopOpacity="0.12" />
          </linearGradient>
        </defs>

        <circle cx={cx} cy={cy} r={r + 8} fill="url(#rank-radar-glow)" />

        {rings.map((f) => (
          <polygon
            key={f}
            className="rank-radar__ring"
            points={gridRingPath(cx, cy, r, RADAR_AXES.length, f)}
          />
        ))}

        {main.map((p) => (
          <line
            key={p.key}
            className="rank-radar__axis"
            x1={cx}
            y1={cy}
            x2={p.tipX}
            y2={p.tipY}
          />
        ))}

        {ghostPts && (
          <polygon
            className="rank-radar__ghost"
            points={radarPolygon(ghostPts)}
          />
        )}

        <polygon className="rank-radar__poly" points={radarPolygon(main)} />

        {main.map((p) => (
          <g key={`dot-${p.key}`}>
            <circle className="rank-radar__dot" cx={p.x} cy={p.y} r={3.5} />
            <text
              className="rank-radar__label"
              x={p.tipX + (p.tipX - cx) * 0.12}
              y={p.tipY + (p.tipY - cy) * 0.12}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {p.label.slice(0, 3)} {p.score}
            </text>
          </g>
        ))}

        <circle className="rank-radar__core" cx={cx} cy={cy} r={4} />
      </svg>
      <div className="rank-radar__caption">
        <strong>{entry.modelId}</strong>
        <span>
          overall {entry.overall} · η{costEfficiency(entry)} · {costLabel(entry)}
        </span>
        {ghostPts && ghost && (
          <span className="rank-radar__ghost-cap">
            sombra: #{ghost.rank ?? 1} {ghost.modelId}
          </span>
        )}
      </div>
    </div>
  );
}

function MissionPicks({
  entries,
  onSelect,
}: {
  entries: PublicModelRankingEntry[];
  onSelect: (id: string) => void;
}) {
  const missions: Array<{ key: SortKey | 'value'; label: string; pick: PublicModelRankingEntry | null }> = [
    { key: 'coding', label: SORT_MISSION.coding, pick: pickForDimension(entries, 'coding') },
    { key: 'reasoning', label: SORT_MISSION.reasoning, pick: pickForDimension(entries, 'reasoning') },
    { key: 'frontend', label: SORT_MISSION.frontend, pick: pickForDimension(entries, 'frontend') },
    { key: 'security', label: SORT_MISSION.security, pick: pickForDimension(entries, 'security') },
    { key: 'value', label: 'Melhor custo / overall', pick: pickValue(entries) },
  ];

  return (
    <div className="rank-missions" role="list" aria-label="Picks do motor por tipo de missão">
      {missions.map((m) => {
        if (!m.pick) return null;
        const score =
          m.key === 'value'
            ? m.pick.overall
            : scoreOf(m.pick, m.key) ?? m.pick.overall;
        return (
          <button
            key={m.key}
            type="button"
            role="listitem"
            className="rank-missions__card"
            onClick={() => onSelect(m.pick!.id)}
          >
            <span className="rank-missions__kind">
              {m.key === 'value' ? 'Value' : SORT_LABELS[m.key]}
            </span>
            <span className="rank-missions__model">{m.pick.modelId}</span>
            <span className="rank-missions__meta">
              {m.label} · score {score}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ModelRankingSection() {
  const [snapshot, setSnapshot] = useState<Awaited<
    ReturnType<NonNullable<typeof window.nexus>['ranking']['public']>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('overall');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const providers = useProviderStore((s) => s.providers);
  const fleetQuota = useQuotaStore((s) => s.snapshot);
  const quotaByAdapter = useMemo(
    () => quotaAvailabilityByAdapter(fleetQuota),
    [fleetQuota],
  );
  const installed = useMemo(() => {
    const set = new Set<string>();
    for (const p of providers) {
      if (p.installed && p.enabled) set.add(p.adapterId);
    }
    return set;
  }, [providers]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const publicRanking = window.nexus?.ranking?.public;
    if (typeof publicRanking !== 'function') {
      setError('API de ranking indisponível neste build.');
      setLoading(false);
      return;
    }
    void publicRanking()
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setError(null);
        setSelectedId((prev) => {
          if (prev && data.entries.some((e) => e.id === prev)) return prev;
          const top = sortEntriesWithQuota(
            data.entries,
            'overall',
            quotaAvailabilityByAdapter(useQuotaStore.getState().snapshot),
          )[0];
          return top?.id ?? null;
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    if (sort === 'overall') {
      return sortEntriesWithQuota(snapshot.entries, sort, quotaByAdapter);
    }
    return sortEntries(snapshot.entries, sort);
  }, [snapshot, sort, quotaByAdapter]);

  const selected = useMemo(() => {
    if (!snapshot || !selectedId) return null;
    return snapshot.entries.find((e) => e.id === selectedId) ?? rows[0] ?? null;
  }, [snapshot, selectedId, rows]);

  const leader = useMemo(() => {
    if (!snapshot) return null;
    return sortEntriesWithQuota(snapshot.entries, 'overall', quotaByAdapter)[0] ?? null;
  }, [snapshot, quotaByAdapter]);

  const liveCount = useMemo(
    () => rows.filter((r) => installed.has(r.adapterId)).length,
    [rows, installed],
  );

  return (
    <section className="rank-ops" aria-labelledby="ranking-title">
      <header className="rank-ops__intro">
        <h3 id="ranking-title" className="settings-detail__title">
          Motor de ranking LLM
        </h3>
        <p className="settings-detail__hint">
          Nexus-eval multi-eixo alimenta o roteador de missões. Escolha a
          dimensão da corrida, inspecione o radar do modelo e veja quem o
          motor mandaria para cada tipo de tarefa — não só uma tabela de
          números.
        </p>
      </header>

      {loading && (
        <p className="rank-ops__status" role="status">
          Carregando snapshot de eval…
        </p>
      )}
      {error && (
        <p className="rank-ops__status rank-ops__status--error" role="alert">
          Falha ao carregar ranking: {error}
        </p>
      )}

      {snapshot && (
        <>
          <div className="rank-ops__fleet" role="status">
            <span>
              suite <code>{snapshot.suiteId}</code>
              <span className="rank-ops__dim">/{snapshot.suiteRevision}</span>
            </span>
            <span className="rank-ops__sep" aria-hidden="true">
              ·
            </span>
            <span>
              <strong>{snapshot.entries.length}</strong> modelos
            </span>
            <span className="rank-ops__sep" aria-hidden="true">
              ·
            </span>
            <span>
              <strong>{liveCount}</strong> com CLI live aqui
            </span>
            <span className="rank-ops__sep" aria-hidden="true">
              ·
            </span>
            <span className="rank-ops__dim">
              gerado {formatEvalTime(snapshot.generatedAt)}
            </span>
          </div>

          <div className="rank-ops__block">
            <h4 className="rank-ops__block-title">Picks do motor por missão</h4>
            <MissionPicks entries={snapshot.entries} onSelect={setSelectedId} />
          </div>

          <div
            className="rank-ops__sort"
            role="group"
            aria-label="Dimensão da corrida"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`rank-ops__chip ${sort === key ? 'rank-ops__chip--on' : ''}`}
                onClick={() => setSort(key)}
                title={SORT_MISSION[key]}
              >
                {SORT_LABELS[key]}
              </button>
            ))}
          </div>
          <p className="rank-ops__mission-hint">{SORT_MISSION[sort]}</p>

          <div className="rank-ops__stage">
            <div className="rank-ops__stage-main">
              <h4 className="rank-ops__block-title">
                Corrida · {SORT_LABELS[sort]}
              </h4>
              <RaceChart
                rows={rows}
                sort={sort}
                selectedId={selected?.id ?? null}
                installed={installed}
                onSelect={setSelectedId}
              />
            </div>
            <div className="rank-ops__stage-side">
              <h4 className="rank-ops__block-title">Radar operacional</h4>
              {selected ? (
                <RadarChart entry={selected} ghost={leader} />
              ) : (
                <p className="rank-ops__status">Selecione um modelo na corrida.</p>
              )}
            </div>
          </div>

          {selected && (
            <div className="rank-ops__detail" aria-live="polite">
              <div className="rank-ops__detail-head">
                <span className="rank-ops__detail-name">{selected.modelId}</span>
                <span className="rank-ops__detail-adapter">
                  {selected.adapterId}
                  {installed.has(selected.adapterId)
                    ? ' · CLI pronta neste host'
                    : ' · CLI não detectada / off'}
                </span>
              </div>
              <div className="rank-ops__dims">
                {RADAR_AXES.map((key) => {
                  const v = scoreOf(selected, key);
                  return (
                    <div key={key} className="rank-ops__dim-cell">
                      <span className="rank-ops__dim-label">{SORT_LABELS[key]}</span>
                      <span className="rank-ops__dim-val">
                        {v === null ? '—' : v}
                      </span>
                      <span
                        className="rank-ops__dim-bar"
                        aria-hidden="true"
                        style={{
                          width: `${v === null ? 0 : Math.min(100, v)}%`,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="rank-ops__foot">
                fonte {selected.source} · conf{' '}
                {selected.confidence !== undefined
                  ? `${Math.round(selected.confidence * 100)}%`
                  : '—'}{' '}
                · avaliado {formatEvalTime(selected.evaluatedAt)}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
