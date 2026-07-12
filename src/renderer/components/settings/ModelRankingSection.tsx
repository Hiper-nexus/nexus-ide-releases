import { useEffect, useMemo, useState } from 'react';
import type { PublicModelRankingSnapshot } from '../../../shared/eval-ranking-types';

type SortKey = 'overall' | 'coding' | 'reasoning' | 'frontend' | 'security';

const SORT_LABELS: Record<SortKey, string> = {
  overall: 'Overall',
  coding: 'Coding',
  reasoning: 'Reasoning',
  frontend: 'Frontend',
  security: 'Security',
};

function scoreOf(
  entry: PublicModelRankingSnapshot['entries'][number],
  key: SortKey,
): number {
  const v = entry[key];
  return typeof v === 'number' ? v : -1;
}

/**
 * In-app public LLM ranking — same DTO as resources/model-ranking.json / landing.
 */
export function ModelRankingSection() {
  const [snapshot, setSnapshot] = useState<PublicModelRankingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('overall');
  const [loading, setLoading] = useState(true);

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
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
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
    return [...snapshot.entries].sort(
      (a, b) => scoreOf(b, sort) - scoreOf(a, sort),
    );
  }, [snapshot, sort]);

  return (
    <section className="settings-section ranking-section" aria-labelledby="ranking-title">
      <header className="settings-section__header">
        <h3 id="ranking-title">Ranking de modelos</h3>
        <p className="settings-section__lead">
          Avaliação multi-dimensão do Nexus (nexus-eval). O roteador automático
          usa estes scores por tarefa; o mesmo JSON alimenta a landing pública.
        </p>
      </header>

      {loading && <p className="ranking-section__status">Carregando ranking…</p>}
      {error && (
        <p className="ranking-section__status ranking-section__status--error" role="alert">
          Falha ao carregar ranking: {error}
        </p>
      )}

      {snapshot && (
        <>
          <div className="ranking-section__meta">
            <span>
              Suite <code>{snapshot.suiteId}</code> · rev{' '}
              <code>{snapshot.suiteRevision}</code>
            </span>
            <span>schema v{snapshot.schemaVersion}</span>
            <span>{snapshot.entries.length} modelos</span>
          </div>

          <div className="ranking-section__sort" role="group" aria-label="Ordenar por dimensão">
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={
                  sort === key
                    ? 'ranking-section__chip ranking-section__chip--active'
                    : 'ranking-section__chip'
                }
                onClick={() => setSort(key)}
              >
                {SORT_LABELS[key]}
              </button>
            ))}
          </div>

          <div className="ranking-section__table-wrap">
            <table className="ranking-section__table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Modelo</th>
                  <th scope="col">Overall</th>
                  <th scope="col">Coding</th>
                  <th scope="col">Reasoning</th>
                  <th scope="col">Frontend</th>
                  <th scope="col">Security</th>
                  <th scope="col">Custo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry, index) => (
                  <tr key={entry.id}>
                    <td>{index + 1}</td>
                    <td>
                      <strong>{entry.modelId}</strong>
                      <div className="ranking-section__adapter">{entry.adapterId}</div>
                    </td>
                    <td>{entry.overall}</td>
                    <td>{entry.coding ?? '—'}</td>
                    <td>{entry.reasoning ?? '—'}</td>
                    <td>{entry.frontend ?? '—'}</td>
                    <td>{entry.security ?? '—'}</td>
                    <td>{entry.costTier ?? entry.availability ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="ranking-section__foot">
            Fonte: {rows[0]?.source ?? 'nexus-eval'} · avaliado em{' '}
            {snapshot.generatedAt}
          </p>
        </>
      )}
    </section>
  );
}
