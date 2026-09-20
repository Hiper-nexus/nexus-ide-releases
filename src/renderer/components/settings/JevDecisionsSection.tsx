import { useCallback, useEffect, useState } from 'react';
import type {
  JevDecisionRow,
  JevDecisionStatsResult,
} from '../../../shared/jev-ipc';
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
    <section>
      <SettingsSectionTitle>Decisões do Jev</SettingsSectionTitle>
      <p className="settings-detail__hint">
        Cada vez que o piloto automático consulta o modelo Jev (TypeSafe), o
        Nexus registra a decisão aqui — sem nunca guardar o texto analisado.
        Marque certo ou errado para o app aprender onde ele acerta e onde
        precisa de ajuste.
      </p>

      {error && <p role="alert" className="settings-error">{error}</p>}

      {!stats && !error && (
        <p className="settings-detail__hint">Carregando decisões…</p>
      )}

      {stats && (
        <>
          <h4 className="settings-section-heading">
            Consumo do Jev (TypeSafe)
          </h4>
          <ul className="settings-list">
            {(
              [
                ['Hoje', stats.windows.today],
                ['30 dias', stats.windows.last30d],
                ['Desde sempre', stats.windows.allTime],
              ] as const
            ).map(([label, window]) => (
              <li key={label} className="settings-list__item">
                <div className="settings-list__head">
                  <span className="settings-list__title">{label}</span>
                  <span className="settings-chip">
                    {window.consultations} consultas
                  </span>
                  <span className="settings-chip">
                    {formatUsd(window.usd)}
                  </span>
                  <span className="settings-chip">
                    {window.noAnswer} sem resposta
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="settings-detail__hint">
            Custo estimado: tokens de entrada × US$ 0,042 por milhão (tabela
            pública da TypeSafe; saída é grátis). "Pela regra" = o Jev foi
            consultado e não respondeu (timeout, erro, limite) — a superfície
            decidiu pelo caminho determinístico. Chamada direta à TypeSafe,
            sem intermediário.
          </p>

          <h4 className="settings-section-heading">Por superfície</h4>
          {surfaces.length === 0 ? (
            <p className="settings-detail__hint">
              Nenhuma decisão registrada ainda.
            </p>
          ) : (
            <ul className="settings-list">
              {surfaces.map(([surface, bucket]) => (
                <li key={surface} className="settings-list__item">
                  <div className="settings-list__head">
                    <span className="settings-list__title">
                      {surfaceLabel(surface)}
                    </span>
                    <span className="settings-chip">
                      {bucket.calls} chamadas
                    </span>
                    <span className="settings-chip">
                      {formatUsd(bucket.usd)}
                    </span>
                    <span className="settings-chip">
                      {bucket.last30d.jev} pelo Jev · {bucket.last30d.rule}{' '}
                      pela regra · {formatUsd(bucket.last30d.usd)} (30 dias)
                    </span>
                    {bucket.noAnswer > 0 && (
                      <span className="settings-chip">
                        {bucket.noAnswer} sem resposta
                      </span>
                    )}
                    <span className="settings-chip settings-chip--ok">
                      {bucket.feedback.right} certas
                    </span>
                    <span className="settings-chip">
                      {bucket.feedback.wrong} erradas
                    </span>
                  </div>
                  <p className="settings-list__detail">
                    {Object.entries(bucket.decisions)
                      .map(([decision, count]) => `${decision} ×${count}`)
                      .join(' · ')}
                  </p>
                  {bucket.suggestion && (
                    <p className="settings-list__detail">{bucket.suggestion}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h4 className="settings-section-heading">Últimas decisões</h4>
          {rows.length === 0 ? (
            <p className="settings-detail__hint">
              Nenhuma decisão registrada ainda.
            </p>
          ) : (
            <ul className="settings-list">
              {rows.map((row) => (
                <li key={row.id} className="settings-list__item">
                  <div className="settings-list__head">
                    <span className="settings-list__title">
                      {surfaceLabel(row.surface)} — {row.decision}
                    </span>
                    {row.feedback && (
                      <span
                        className={`settings-chip ${row.feedback === 'right' ? 'settings-chip--ok' : ''}`}
                      >
                        {row.feedback === 'right' ? 'certa' : 'errada'}
                      </span>
                    )}
                  </div>
                  <p className="settings-list__detail">
                    {formatTime(row.at)} · {row.model} · {topProbabilities(row)}
                  </p>
                  <div className="settings-list__head">
                    <button
                      type="button"
                      className="settings-btn settings-btn--sm"
                      onClick={() => void sendFeedback(row.id, 'right')}
                    >
                      Certo
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn--sm"
                      onClick={() => void sendFeedback(row.id, 'wrong')}
                    >
                      Errado
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
