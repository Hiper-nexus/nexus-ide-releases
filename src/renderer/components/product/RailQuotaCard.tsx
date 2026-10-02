import { useId, useMemo, useState } from 'react';
import type { ProviderQuotaEntry } from '../../../shared/quota-types';
import { collapseSharedQuotaEntries } from '../../../shared/quota-types';
import type { PetLifetimeStats } from '../../../shared/pet-types';
import { fmtTokens, fmtUsd } from '../../lib/lifetime-format';
import { prioritizeReportedQuotas, shortWindowsLine } from '../../lib/quota-display';
import {
  loadQuotaCardExpanded,
  saveQuotaCardExpanded,
} from '../../lib/rail-quota-prefs';
import { ProviderLogo } from '../ProviderLogo';

/** Quantas contas o card mostra recolhido: as que mais consomem. */
const COLLAPSED_VISIBLE = 4;

export interface RailQuotaCardProps {
  entries: readonly ProviderQuotaEntry[];
  /** Relógio do minuto: os contadores de reset andam por aqui. */
  now: number;
  lifetimeUsage: PetLifetimeStats | null;
  onOpenUsage(): void;
}

interface QuotaItemView {
  tone: 'ok' | 'warn' | 'danger' | 'unknown';
  percentLabel: string;
  worst: number | null;
  line: string;
  title: string;
  authExpired: boolean;
}

/**
 * A barra e o percentual vêm SOMENTE da telemetria real do serviço. Um
 * cooldown/limit-hit jamais pinta 100% falso por cima de uma leitura fresca
 * (ex.: conta pausada com Semanal 54%) — a pausa aparece como selo, o
 * percentual é o fato.
 */
function describeQuotaItem(entry: ProviderQuotaEntry, now: number): QuotaItemView {
  const identityMismatch = entry.readHint === 'identity-mismatch';
  const visible = identityMismatch ? { ...entry, windows: [] } : entry;
  let worst: number | null = null;
  for (const window of visible.windows) {
    if (window.usedRatio === null) continue;
    if (worst === null || window.usedRatio > worst) worst = window.usedRatio;
  }
  const authExpired = entry.readHint === 'auth-expired' || identityMismatch;
  const tone: QuotaItemView['tone'] =
    worst === null
      ? authExpired
        ? 'warn'
        : 'unknown'
      : worst >= 0.8
        ? 'danger'
        : worst >= 0.5
          ? 'warn'
          : 'ok';
  const percentLabel =
    worst === null ? (authExpired ? 'relogin' : '—') : `${Math.round(worst * 100)}%`;
  // Estilo Orca compacto: janelas informadas ("Sem 41% · 5d").
  const line = shortWindowsLine(visible, now, { compact: true });
  const cooldownTitle = authExpired
    ? identityMismatch
      ? ' · credencial de outra conta Claude — entre novamente em Ajustes › Uso e cotas'
      : ' · sessão expirada — reautentique a conta em Ajustes › Uso e cotas'
    : entry.onCooldown
      ? ' · pausa temporária após sinal de limite (percentual = última leitura do serviço)'
      : '';
  return { tone, percentLabel, worst, line, title: `${line}${cooldownTitle}`, authExpired };
}

function QuotaItem({ entry, now }: { entry: ProviderQuotaEntry; now: number }) {
  const view = describeQuotaItem(entry, now);
  const paused = entry.onCooldown && !view.authExpired;
  return (
    <div
      role="listitem"
      className={`workspace-rail__quota-item${paused ? ' workspace-rail__quota-item--cool' : ''}`}
      title={view.title}
    >
      <div className="workspace-rail__quota-info">
        <span className="workspace-rail__quota-name">
          <ProviderLogo adapterId={entry.adapterId} label={entry.label} size="xs" />
          <span>{entry.label}</span>
        </span>
        <span className="workspace-rail__quota-tail">
          {paused ? (
            <span className="workspace-rail__quota-pause" title="Conta em pausa temporária">
              pausa
            </span>
          ) : null}
          <span className={`workspace-rail__quota-val workspace-rail__quota-val--${view.tone}`}>
            {view.percentLabel}
          </span>
        </span>
      </div>
      {view.line ? (
        <span className="workspace-rail__quota-line" title={view.line}>
          {view.line}
        </span>
      ) : null}
      <div className="workspace-rail__quota-track">
        <div
          className={`workspace-rail__quota-bar workspace-rail__quota-bar--${view.tone}`}
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, view.worst ?? 0))})` }}
        />
      </div>
    </div>
  );
}

/**
 * Cotas no rodapé da barra lateral. Recolhido mostra os 4 que mais consomem;
 * um clique expande TODAS as contas (com a janela de cada uma) e outro
 * recolhe. A página completa de uso continua a um botão de distância.
 */
export function RailQuotaCard({
  entries,
  now,
  lifetimeUsage,
  onOpenUsage,
}: RailQuotaCardProps) {
  const listId = useId();
  const all = useMemo(
    () => prioritizeReportedQuotas(collapseSharedQuotaEntries([...entries])),
    [entries],
  );
  const expandable = all.length > COLLAPSED_VISIBLE;
  const [savedExpanded, setSavedExpanded] = useState(loadQuotaCardExpanded);
  const expanded = expandable && savedExpanded;
  const visible = expanded ? all : all.slice(0, COLLAPSED_VISIBLE);
  const providers = useMemo(() => new Set(all.map((e) => e.adapterId)).size, [all]);

  const activate = () => {
    if (!expandable) {
      onOpenUsage();
      return;
    }
    const next = !expanded;
    setSavedExpanded(next);
    saveQuotaCardExpanded(next);
  };

  const hint = !expandable ? 'Ver' : expanded ? 'Recolher' : `Ver todas (${all.length})`;
  const showUsage =
    lifetimeUsage !== null &&
    (lifetimeUsage.tokensBurned > 0 || lifetimeUsage.usdEquivalent > 0);

  return (
    <div
      className={`workspace-rail__cockpit${expanded ? ' workspace-rail__cockpit--expanded' : ''}`}
    >
      <button
        type="button"
        className="workspace-rail__cockpit-header"
        aria-expanded={expandable ? expanded : undefined}
        aria-controls={expandable ? listId : undefined}
        aria-label={
          !expandable
            ? 'Ver uso de cotas nas Configurações'
            : expanded
              ? 'Recolher cotas'
              : `Ver todas (${all.length}) as contas e suas cotas`
        }
        title="Cotas de IA disponíveis"
        onClick={activate}
      >
        <span className="workspace-rail__cockpit-title">Cotas</span>
        <span className="workspace-rail__cockpit-detail-hint">{hint}</span>
      </button>
      {expanded ? (
        <div className="workspace-rail__cockpit-summary">
          {providers} {providers === 1 ? 'provedor' : 'provedores'} · {all.length}{' '}
          {all.length === 1 ? 'conta' : 'contas'}
        </div>
      ) : null}
      {/* Mouse: o corpo do card também alterna. Teclado e leitor de tela usam o botão acima. */}
      <div
        id={listId}
        role="list"
        className="workspace-rail__cockpit-bars"
        aria-label="Cotas por conta"
        onClick={expanded ? undefined : activate}
      >
        {visible.map((entry) => (
          <QuotaItem key={entry.id} entry={entry} now={now} />
        ))}
      </div>
      {expanded ? (
        <button
          type="button"
          className="workspace-rail__cockpit-open"
          onClick={onOpenUsage}
        >
          Abrir uso e cotas
        </button>
      ) : null}
      {showUsage ? (
        <div
          className="workspace-rail__cockpit-usage"
          title="Consumo real acumulado em todos os projetos — o que custaria em API paga; a assinatura já cobre"
        >
          <span>⚡ {fmtTokens(lifetimeUsage.tokensBurned)} tok torrados</span>
          <span className="workspace-rail__cockpit-usage-usd">
            {fmtUsd(lifetimeUsage.usdEquivalent)} em API
          </span>
        </div>
      ) : null}
    </div>
  );
}
