// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: PoolBar/PoolWindowCard/
// PoolSection/LegendRow em React puro com CSS do Nexus (sem Tailwind, @base-ui,
// popover nem resgate de crédito); conta pelo rótulo mascarado da frota + ProviderLogo
// (sem cor/iniciais derivadas de e-mail); coluna sem leitura vira "—"; sem pace.

import type { ProviderQuotaEntry } from '../../../shared/quota-types';
// Puro (só imports de shared): a mesma máscara de rótulo do Redline e do scorer.
import { maskFleetLabel } from '../../../main/quota/smart-pick';
import { formatResetCountdown, windowDisplay } from '../../lib/quota-display';
import {
  collectQuotaPools,
  nextPoolRefill,
  poolAccountLabel,
  poolToolLabel,
  type QuotaPool,
  type QuotaPoolColumn,
  type QuotaPoolReset,
  type QuotaPoolWindow,
} from '../../lib/quota-pool';
import { ProviderLogo } from '../ProviderLogo';

function percent(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function accountName(entry: ProviderQuotaEntry): string {
  return maskFleetLabel(poolAccountLabel(entry));
}

/** O que a coluna diz em voz alta: conta, quanto resta e quando renova. */
function columnSummary(column: QuotaPoolColumn, now: number): string {
  const name = accountName(column.entry);
  if (!column.member) return `${name}: sem leitura desta janela`;
  const countdown = formatResetCountdown(column.member.window.resetsAt, now);
  return `${name}: ${percent(1 - column.member.usedRatio)} restante${countdown ? `, renova em ${countdown}` : ''}`;
}

/**
 * Uma conta numa janela do conjunto. Largo, o segmento leva nome, quanto
 * resta e a renovação; estreito, só o número da posição — a legenda abaixo
 * repete o texto na mesma ordem. A parte gasta fica hachurada quando há
 * renovação conhecida: é o que a contagem regressiva devolve.
 */
function PoolSegment({
  column,
  index,
  reset,
  now,
  showName,
}: {
  column: QuotaPoolColumn;
  index: number;
  reset: QuotaPoolReset | undefined;
  now: number;
  showName: boolean;
}) {
  const summary = columnSummary(column, now);
  const member = column.member;
  if (!member) {
    return (
      <li className="quota-pool__segment quota-pool__segment--unknown" style={{ gridColumn: index }} title={summary}>
        <span className="settings-visually-hidden">{summary}</span>
        <span className="quota-pool__segment-index" aria-hidden="true">{index}</span>
        <span className="quota-pool__segment-detail" aria-hidden="true">
          {showName && <span className="quota-pool__segment-name">{accountName(column.entry)}</span>}
          <span className="quota-pool__segment-pct">—</span>
        </span>
      </li>
    );
  }
  const remaining = 1 - member.usedRatio;
  const tone = windowDisplay(member.window).tone;
  const countdown = formatResetCountdown(member.window.resetsAt, now);
  return (
    <li className="quota-pool__segment" style={{ gridColumn: index }} title={summary}>
      <span className="settings-visually-hidden">{summary}</span>
      <span
        aria-hidden="true"
        className={`quota-pool__fill quota-pool__fill--${tone}`}
        style={{ width: `${remaining * 100}%` }}
      />
      {remaining < 1 && reset && (
        <span aria-hidden="true" className="quota-pool__spent" style={{ width: `${member.usedRatio * 100}%` }} />
      )}
      <span className="quota-pool__segment-index" aria-hidden="true">{index}</span>
      <span className="quota-pool__segment-detail" aria-hidden="true">
        {showName && <span className="quota-pool__segment-name">{accountName(column.entry)}</span>}
        <span className="quota-pool__segment-pct">{percent(remaining)}</span>
        {countdown && <span className="quota-pool__segment-reset">renova em {countdown}</span>}
      </span>
    </li>
  );
}

/** Abaixo da faixa quando estreito: uma linha por conta, na ordem da barra. */
function PoolLegend({ pool, now }: { pool: QuotaPoolWindow; now: number }) {
  return (
    <ol className="quota-pool__legend" aria-hidden="true">
      {pool.columns.map((column, position) => {
        const countdown = column.member ? formatResetCountdown(column.member.window.resetsAt, now) : null;
        return (
          <li key={column.entry.id} className="quota-pool__legend-row">
            <span className="quota-pool__legend-index">{position + 1}</span>
            <span className="quota-pool__legend-name">{accountName(column.entry)}</span>
            <span className="quota-pool__legend-pct">
              {column.member ? percent(1 - column.member.usedRatio) : '—'}
            </span>
            <span className="quota-pool__legend-reset">
              {column.member ? (countdown ? `renova em ${countdown}` : '') : 'Não informado'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Uma janela do conjunto como segmentos de mesma largura, um por conta, cada
 * um preenchido pelo que ainda resta naquela conta. Largura igual é honesta:
 * cada conta pesa o mesmo no conjunto, seja qual for o plano.
 */
function PoolBar({ pool, now }: { pool: QuotaPoolWindow; now: number }) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.entry.id, reset]));
  return (
    <div className="quota-pool__bar-wrap">
      <ol
        className="quota-pool__bar"
        aria-label={`${pool.label}: uma coluna por conta`}
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((column, position) => (
          <PoolSegment
            key={column.entry.id}
            column={column}
            index={position + 1}
            reset={restores.get(column.entry.id)}
            now={now}
            showName={pool.columns.length > 1}
          />
        ))}
      </ol>
      <PoolLegend pool={pool} now={now} />
    </div>
  );
}

/**
 * Número do conjunto e a barra segmentada. As contas mantêm a mesma coluna
 * em todas as janelas; quem renova primeiro diz quanto devolve ao conjunto.
 */
function PoolWindowCard({ pool, now }: { pool: QuotaPoolWindow; now: number }) {
  const refill = nextPoolRefill(pool);
  const refillIn = refill ? formatResetCountdown(refill.at, now) : null;
  const partial = pool.members.length < pool.columns.length;
  return (
    <div className="quota-pool__window" data-window={pool.key}>
      <div className="quota-pool__summary">
        <span className="quota-pool__window-label">{pool.label}</span>
        <span className="quota-pool__number">
          <strong>{percent(pool.remainingRatio)}</strong> restante
        </span>
        <span className="quota-pool__coverage">
          {partial
            ? `${pool.members.length} de ${pool.columns.length} contas com leitura`
            : `${pool.columns.length} contas somadas`}
        </span>
        {refill && refillIn && pool.columns.length > 1 && (
          <span className="quota-pool__refill">
            Próxima renovação devolve <strong>+{percent(refill.restoresRatio)}</strong> em {refillIn}
          </span>
        )}
      </div>
      <PoolBar pool={pool} now={now} />
    </div>
  );
}

function PoolGroup({
  pool,
  now,
  supplierLabels,
}: {
  pool: QuotaPool;
  now: number;
  supplierLabels: Readonly<Record<string, string>>;
}) {
  const tool = poolToolLabel(pool);
  const supplier =
    pool.usageProviderId && pool.usageProviderId !== pool.adapterId
      ? (supplierLabels[pool.usageProviderId] ?? pool.usageProviderId)
      : null;
  return (
    <div className="quota-pool__group" data-pool-adapter={pool.adapterId}>
      <h3 className="quota-pool__group-title">
        <ProviderLogo adapterId={pool.adapterId} label={tool} size="sm" />
        <span>{tool}</span>
        {supplier && <span className="quota-pool__supplier">Limites de {supplier}</span>}
      </h3>
      {pool.windows.map((window) => (
        <PoolWindowCard key={window.key} pool={window} now={now} />
      ))}
    </div>
  );
}

/**
 * Folga conjunta por ferramenta: o que resta somando as contas, quem renova
 * primeiro e quanto isso devolve. Só apresenta — a escolha de conta e o
 * failover seguem com o scorer e o `chooseAccount` de sempre.
 */
export function QuotaPoolSection({
  entries,
  now,
  supplierLabels = {},
}: {
  entries: readonly ProviderQuotaEntry[];
  now: number;
  supplierLabels?: Readonly<Record<string, string>>;
}) {
  const pools = collectQuotaPools(entries, now);
  if (pools.length === 0) return null;
  return (
    <section className="quota-pool" aria-labelledby="quota-pool-title">
      <div className="quota-pool__head">
        <h2 className="quota-pool__title" id="quota-pool-title">
          Folga conjunta por ferramenta
        </h2>
        <p className="quota-pool__hint">
          Soma as contas da mesma ferramenta, janela por janela, com o mesmo peso
          para cada conta. Conta sem leitura fica com a coluna vazia e não entra na soma.
        </p>
      </div>
      {pools.map((pool) => (
        <PoolGroup key={pool.key} pool={pool} now={now} supplierLabels={supplierLabels} />
      ))}
    </section>
  );
}
