import { useCallback, useEffect, useState } from 'react';
import type {
  JevDecisionRow,
  JevDecisionStatsResult,
  JevWindowStatsResult,
} from '../../../shared/jev-ipc';
import { EmptyState } from '../ActionCard';
import { PixelIcon } from '../PixelIcon';
import { SettingsSectionTitle } from './SettingsSectionTitle';

const SURFACE_LABELS: Record<string, string> = {
  handoffReview: 'Revisão de handoff',
  intake: 'Triagem do pedido',
  paneState: 'Estado dos panes',
  terminalTriage: 'Triagem de falhas',
  rank: 'Ranking de entregas',
  dispatchGuard: 'Guarda de despacho',
  toolPick: 'Escolha de ferramenta',
  taskRouting: 'Roteamento de tarefas',
  browserTool: 'Piloto do browser',
  computerTool: 'Piloto do desktop',
  judgeTool: 'Tool nexus_judge',
  rankTool: 'Tool nexus_rank',
  helperReuse: 'Reuso de helper ocioso',
};

const NO_ANSWER_REASONS: Record<string, string> = {
  timeout: 'timeout',
  'rate-limited': 'limite',
  'server-error': 'erro do servidor',
  network: 'rede',
  malformed: 'resposta inválida',
  aborted: 'cancelada',
  'client-error': 'configuração ou credencial',
};

function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] ?? surface;
}

function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.0001) return '< US$ 0,0001';
  return `US$ ${usd.toFixed(4)}`;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function topProbabilities(row: JevDecisionRow): string {
  const entries = Object.entries(row.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (entries.length === 0) return '—';
  return entries.map(([id, p]) => `${id} ${p.toFixed(2)}`).join(' · ');
}

const PERIODS = [
  ['Hoje', 'today'],
  ['30 dias', 'last30d'],
  ['Desde sempre', 'allTime'],
] as const;

export function JevDecisionsSection() {
  const [stats, setStats] = useState<JevDecisionStatsResult | null>(null);
  const [rows, setRows] = useState<JevDecisionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [nextStats, nextRows] = await Promise.all([
        window.nexus.jev.decisionsStats(),
        window.nexus.jev.decisionsList({ limit: 50 }),
      ]);
      setStats(nextStats);
      setRows(nextRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function sendFeedback(id: string, verdict: 'right' | 'wrong') {
    try {
      await window.nexus.jev.decisionsFeedback({ id, verdict });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    void refresh();
  }

  const surfaces = Object.entries(stats?.bySurface ?? {});

  return (
    <section className="jev-decisions">
      <div className="jev-decisions__head">
        <SettingsSectionTitle>Decisões dos modelos</SettingsSectionTitle>
        {stats && (
          <button
            type="button"
            className="settings-btn settings-btn--sm jev-decisions__refresh"
            onClick={() => void refresh()}
          >
            <PixelIcon name="refresh" size={12} />
            Atualizar
          </button>
        )}
      </div>
      <p className="settings-detail__hint">
        Cada vez que o piloto automático consulta Jev ou Clef, o
        Nexus registra a decisão aqui — sem nunca guardar o texto analisado.
        Marque certo ou errado para o app aprender onde ele acerta e onde
        precisa de ajuste.
      </p>

      {error && (
        <EmptyState
          role="alert"
          className="jev-decisions__error"
          icon="warn"
          title="Não deu para ler as decisões"
          body={<p className="settings-error">{error}</p>}
          action={
            <button
              type="button"
              className="settings-btn settings-btn--sm"
              onClick={() => void refresh()}
            >
              Tentar de novo
            </button>
          }
        />
      )}

      {!stats && !error && (
        <div className="jev-decisions__loading" role="status">
          <PixelIcon name="bolt" size={14} />
          Carregando decisões…
        </div>
      )}

      {stats && (
        <>
          <h3 className="settings-section-heading">
            Consumo dos modelos de decisão
          </h3>
          <div
            className="jev-periods"
            role="group"
            aria-label="Consumo por período"
          >
            {PERIODS.map(([label, key], i) => {
              const window: JevWindowStatsResult = stats.windows[key];
              return (
                <div
                  key={label}
                  className={`jev-period${i === 0 ? ' jev-period--live' : ''}`}
                >
                  <span className="jev-period__name">
                    {i === 0 && (
                      <span className="jev-period__dot" aria-hidden />
                    )}
                    {label}
                  </span>
                  <span className="jev-period__count">
                    {window.consultations} consultas
                  </span>
                  <span className="jev-period__meta">
                    {formatUsd(window.usd)} · {window.noAnswer} sem resposta
                  </span>
                </div>
              );
            })}
          </div>
          <p className="settings-detail__hint">
            Custo estimado pelas tarifas públicas de cada modelo: Jev US$ 0,042,
            Clef US$ 0,24 e Flash US$ 0,09 por milhão de tokens de entrada.
            Consultas sem resposta podem ter custo não medido. "Pela regra" = o modelo foi
            consultado e não respondeu (timeout, erro, limite) — a superfície
            decidiu pelo caminho determinístico. Chamada direta ao provedor,
            sem intermediário.
          </p>

          <h3 className="settings-section-heading">Otimização observada em 30 dias</h3>
          {stats.windows.last30d.optimization ? (
            <>
              <p className="settings-detail__hint">
                Consultas aos modelos evitadas por lote ou reutilização:{' '}
                {stats.windows.last30d.optimization.jevRequestsAvoided} ·{' '}
                Triagens resolvidas sem recorrer ao LLM:{' '}
                {stats.windows.last30d.optimization.llmRoutingBypassed}.
              </p>
              <p className="settings-detail__hint">
                {stats.windows.last30d.optimization.contextSelections > 0
                  ? `Texto de páginas selecionado: ${stats.windows.last30d.optimization.contextBytesBefore.toLocaleString('pt-BR')} → ${stats.windows.last30d.optimization.contextBytesAfter.toLocaleString('pt-BR')} bytes, em ${stats.windows.last30d.optimization.contextSelections} leituras.`
                  : 'Ainda sem seleção de texto de páginas registrada.'}
                {' '}Bytes medem o texto selecionado antes da formatação; não representam tokens
                {' '}faturados nem economia total do LLM.
              </p>
            </>
          ) : (
            <p className="settings-detail__hint">
              Ainda sem medição de otimização. O histórico anterior continua
              {' '}contabilizado no consumo acima.
            </p>
          )}

          {stats.byModel && Object.keys(stats.byModel).length > 0 && <>
            <h3 className="settings-section-heading">Por modelo · desde sempre</h3>
            <div className="decision-models__table"><table aria-label="Consumo por modelo">
              <thead><tr><th>Modelo</th><th>Consultas</th><th>Estimativa</th><th>Sem resposta</th><th>Tentativas HTTP</th></tr></thead>
              <tbody>{Object.entries(stats.byModel).map(([model, usage]) => <tr key={model}>
                <td>{model}</td><td>{usage.calls}</td><td>{usage.incompleteUsageCalls ? '≥ ' : ''}{formatUsd(usage.usd)}</td><td>{usage.noAnswer}</td><td>{usage.requests ?? 'Sem medição'}</td>
              </tr>)}</tbody>
            </table></div>
          </>}
          <h3 className="settings-section-heading">Por superfície</h3>
          {surfaces.length === 0 ? (
            <p className="jev-decisions__hint">
              Nenhuma decisão registrada ainda.
            </p>
          ) : (
            <div
              className="jev-table"
              role="list"
              aria-label="Consumo por superfície"
            >
              <div className="jev-table__head" aria-hidden="true">
                <span>Superfície</span>
                <span className="jev-cell--num">Chamadas</span>
                <span className="jev-cell--num">Custo</span>
                <span>Últimos 30 dias</span>
                <span>Feedback</span>
              </div>
              {surfaces.map(([surface, bucket]) => (
                <div key={surface} className="jev-surface" role="listitem">
                  <div className="jev-surface__grid">
                    <span className="jev-surface__name">
                      {surfaceLabel(surface)}
                    </span>
                    <span className="jev-cell jev-cell--num">
                      {bucket.calls} chamadas
                    </span>
                    <span className="jev-cell jev-cell--num">
                      {formatUsd(bucket.usd)}
                    </span>
                    <span className="jev-cell">
                      {bucket.last30d.jev} pelo modelo · {bucket.last30d.rule}{' '}
                      pela regra · {formatUsd(bucket.last30d.usd)}{' '}
                      <span className="jev-cell__u">(30 dias)</span>
                    </span>
                    <span className="jev-cell jev-surface__fb">
                      <span className="jev-tag jev-tag--ok">
                        {bucket.feedback.right} certas
                      </span>
                      <span className="jev-tag">
                        {bucket.feedback.wrong} erradas
                      </span>
                      {bucket.noAnswer > 0 && (
                        <span className="jev-tag jev-tag--warn">
                          {bucket.noAnswer} sem resposta
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="jev-surface__detail">
                    {Object.entries(bucket.decisions)
                      .map(([decision, count]) => `${decision} ×${count}`)
                      .join(' · ')}
                    {bucket.suggestion && (
                      <span className="jev-surface__suggestion">
                        {bucket.suggestion}
                      </span>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}

          <h3 className="settings-section-heading">Últimas decisões</h3>
          {rows.length === 0 ? (
            <EmptyState
              icon="board"
              title="Sem decisões ainda"
              body={
                <p>
                  Assim que o piloto automático consultar um modelo, cada decisão
                  aparece aqui para você marcar certo ou errado.
                </p>
              }
              action={
                <button
                  type="button"
                  className="settings-btn settings-btn--sm"
                  onClick={() => void refresh()}
                >
                  Atualizar
                </button>
              }
            />
          ) : (
            <ul className="jev-log">
              {rows.map((row) => {
                const noAnswer = row.kind === 'no-answer';
                return (
                  <li key={row.id} className="jev-log__row">
                    <div className="jev-log__body">
                      <div className="jev-log__line">
                        <span className="jev-log__surface">
                          {surfaceLabel(row.surface)}
                        </span>
                        <span
                          className={`jev-log__decision${noAnswer ? ' jev-log__decision--rule' : ''}`}
                        >
                          {noAnswer
                            ? `pela regra (${NO_ANSWER_REASONS[row.reason ?? ''] ?? 'sem resposta'})`
                            : row.decision}
                        </span>
                      </div>
                      <p className="jev-log__meta">
                        {formatTime(row.at)} · {row.provider === 'clef' || row.model.startsWith('clef') ? 'Cloudflare' : 'TypeSafe'} · {row.model} ·{' '}
                        {topProbabilities(row)}
                        {row.route?.reason === 'credential-fallback' ? ' · alternativa disponível' : row.route?.evidence === 'public-benchmark' ? ' · regra inicial' : ''}
                      </p>
                    </div>
                    <div
                      className="jev-vote"
                      role="group"
                      aria-label="Este acerto estava certo ou errado?"
                    >
                      <button
                        type="button"
                        className={`jev-vote__btn jev-vote__btn--ok${row.feedback === 'right' ? ' jev-vote__btn--on' : ''}`}
                        aria-pressed={row.feedback === 'right'}
                        onClick={() => void sendFeedback(row.id, 'right')}
                      >
                        <PixelIcon name="check" size={10} />
                        Certo
                      </button>
                      <button
                        type="button"
                        className={`jev-vote__btn jev-vote__btn--wrong${row.feedback === 'wrong' ? ' jev-vote__btn--on' : ''}`}
                        aria-pressed={row.feedback === 'wrong'}
                        onClick={() => void sendFeedback(row.id, 'wrong')}
                      >
                        <PixelIcon name="close" size={10} />
                        Errado
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
