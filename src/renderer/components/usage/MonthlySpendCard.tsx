import { useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import '../../styles/usage-overview.css';
import type { ProviderQuotaEntry } from '../../../shared/quota-types';
import type { SpendEntry, SpendEntryKind } from '../../../shared/settings-types';
import {
  MONTHLY_SPEND_PRESETS_USD,
  PLAN_PRESETS,
  SPEND_PROVIDER_OPTIONS,
  buildSpendRows,
  computeMonthlySpend,
  newSpendEntryId,
  parseUsdInput,
  removeSpendEntry,
  toSpendEntry,
  upsertSpendEntry,
  type DetectedPlan,
  type SpendRow,
} from '../../../shared/monthly-spend';
import { useSpendSettings } from '../../state/spend-settings';
import { EmptyState } from '../ActionCard';
import { PixelIcon } from '../PixelIcon';
import { ProviderLogo } from '../ProviderLogo';
import { formatUsdAmount, usageProviderLabel } from '../../lib/usage-overview';

/**
 * Gasto mensal REAL com IA, em USD: o que a pessoa paga em cada plano e em
 * API avulsa, editado na própria linha. Plano detectado entra com o preço de
 * lista; o valor digitado vence (o preço muda, há imposto, há câmbio). O
 * total é comparado com o equivalente de API dos últimos 30 dias em todos os
 * projetos — a economia que a assinatura entrega, ou o quanto passou dela.
 */

/** Linhas de cota → planos detectados (o preço gratuito não é gasto). */
function detectedPlansFrom(entries: readonly ProviderQuotaEntry[]): DetectedPlan[] {
  return entries.flatMap((entry) =>
    entry.plan && entry.plan.monthlyUsd !== 0
      ? [
          {
            key: entry.id,
            provider: entry.adapterId,
            accountLabel: entry.label.replace(/\s*·\s*CLI nativo$/u, ''),
            planLabel: entry.plan.label,
            monthlyUsd: entry.plan.monthlyUsd,
          },
        ]
      : [],
  );
}

function inputText(value: number | null): string {
  return value === null ? '' : value.toFixed(2);
}

function SpendRowItem({
  row,
  saving,
  onCommit,
  onToggle,
  onRemove,
  onRestore,
}: {
  row: SpendRow;
  saving: boolean;
  onCommit: (row: SpendRow, monthlyUsd: number) => void;
  onToggle: (row: SpendRow) => void;
  onRemove: (row: SpendRow) => void;
  onRestore: (row: SpendRow) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(inputText(row.monthlyUsd));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(inputText(row.monthlyUsd));
    setInvalid(false);
  }, [row.monthlyUsd]);

  const commit = () => {
    if (draft.trim() === inputText(row.monthlyUsd)) {
      setInvalid(false);
      return;
    }
    const value = parseUsdInput(draft);
    if (value === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (value !== row.monthlyUsd || row.source === 'detected') onCommit(row, value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      setDraft(inputText(row.monthlyUsd));
      setInvalid(false);
    }
  };
  const providerLabel = row.provider ? usageProviderLabel(row.provider) : 'Gasto avulso';
  const origin =
    row.kind === 'api'
      ? 'Gasto de API'
      : row.detected
        ? row.source === 'saved'
          ? `${row.detected.planLabel} detectado · valor informado por você`
          : row.detected.monthlyUsd === null
            ? `${row.detected.planLabel} detectado · sem preço público, informe o valor`
            : `${row.detected.planLabel} detectado · preço de lista`
        : 'Assinatura informada por você';
  const canRestore =
    row.source === 'saved' &&
    row.detected !== undefined &&
    row.detected.monthlyUsd !== null &&
    row.detected.monthlyUsd !== row.monthlyUsd;

  return (
    <li className="spend-row" data-active={row.active} data-kind={row.kind}>
      <div className="spend-row__identity">
        {row.provider ? (
          <ProviderLogo adapterId={row.provider} label={providerLabel} size="sm" />
        ) : (
          <span className="spend-row__glyph" aria-hidden="true">
            <PixelIcon name="bolt" size={14} />
          </span>
        )}
        <div className="spend-row__text">
          <p className="spend-row__label">{row.label}</p>
          <p className="spend-row__origin">{origin}</p>
        </div>
      </div>
      <div className="spend-row__value">
        <div className="spend-row__presets" role="group" aria-label={`Valores rápidos para ${row.label}`}>
          {MONTHLY_SPEND_PRESETS_USD.map((preset) => (
            <button
              key={preset}
              type="button"
              className="spend-chip"
              aria-pressed={row.monthlyUsd === preset}
              disabled={saving}
              onClick={() => onCommit(row, preset)}
            >
              ${preset}
            </button>
          ))}
        </div>
        <label className="spend-row__field" htmlFor={inputId}>
          <span className="settings-visually-hidden">Valor mensal de {row.label} em dólares</span>
          <span className="spend-row__currency" aria-hidden="true">
            US$
          </span>
          <input
            id={inputId}
            className="settings-input spend-row__input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={draft}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
          <span className="spend-row__unit" aria-hidden="true">
            /mês
          </span>
        </label>
        <label className="spend-row__toggle">
          {/* Sem valor a linha já fica fora da soma: o toggle não grava US$ 0 por ela. */}
          <input
            type="checkbox"
            checked={row.active}
            disabled={saving || row.monthlyUsd === null}
            onChange={() => onToggle(row)}
          />
          <span>No total</span>
        </label>
        {canRestore ? (
          <button type="button" className="spend-row__link" disabled={saving} onClick={() => onRestore(row)}>
            Usar preço de lista ({formatUsdAmount(row.detected!.monthlyUsd!)})
          </button>
        ) : null}
        {row.source === 'saved' && !row.detected ? (
          <button
            type="button"
            className="spend-row__remove"
            aria-label={`Remover ${row.label}`}
            title={`Remover ${row.label}`}
            disabled={saving}
            onClick={() => onRemove(row)}
          >
            <PixelIcon name="trash" size={14} />
          </button>
        ) : null}
      </div>
      {invalid ? (
        <p className="spend-row__error" id={errorId} role="alert">
          Use um valor em dólar entre 0 e 100.000, como 20 ou 216,50.
        </p>
      ) : null}
    </li>
  );
}

function AddSpendForm({
  saved,
  saving,
  onAdd,
  onCancel,
}: {
  saved: readonly SpendEntry[];
  saving: boolean;
  onAdd: (entry: SpendEntry) => void;
  onCancel: () => void;
}) {
  const nameId = useId();
  const providerId = useId();
  const valueId = useId();
  const errorId = useId();
  const [kind, setKind] = useState<SpendEntryKind>('subscription');
  const [provider, setProvider] = useState('claude');
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const monthlyUsd = parseUsdInput(value);
    if (monthlyUsd === null) {
      setError('Informe o valor em dólar por mês, como 20 ou 216,50.');
      return;
    }
    const fallback =
      SPEND_PROVIDER_OPTIONS.find((option) => option.provider === provider)?.label ?? 'Assinatura';
    onAdd({
      id: newSpendEntryId(saved, Date.now()),
      label: (label.trim() || (kind === 'api' ? `API ${fallback}` : fallback)).slice(0, 64),
      kind,
      provider,
      monthlyUsd,
      active: true,
    });
  };

  return (
    <form className="spend-add" onSubmit={submit} aria-label="Adicionar gasto mensal">
      <div className="spend-add__row">
        <div className="usage-segmented" role="group" aria-label="Tipo de gasto">
          {(
            [
              ['subscription', 'Assinatura'],
              ['api', 'Gasto de API'],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              type="button"
              className="usage-segmented__btn"
              aria-pressed={kind === key}
              onClick={() => setKind(key)}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {kind === 'subscription' ? (
        <div className="spend-add__plans" role="group" aria-label="Planos conhecidos">
          {PLAN_PRESETS.map((plan) => (
            <button
              key={plan.id}
              type="button"
              className="spend-chip"
              onClick={() => {
                setProvider(plan.provider);
                setLabel(plan.label);
                setValue(plan.monthlyUsd.toFixed(2));
                setError(null);
              }}
            >
              {plan.label} · ${plan.monthlyUsd}
            </button>
          ))}
        </div>
      ) : null}
      <div className="spend-add__fields">
        <label className="spend-add__field" htmlFor={providerId}>
          <span>Ferramenta</span>
          <select
            id={providerId}
            className="settings-input"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            {SPEND_PROVIDER_OPTIONS.map((option) => (
              <option key={option.provider || 'outro'} value={option.provider}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="spend-add__field" htmlFor={nameId}>
          <span>Nome</span>
          <input
            id={nameId}
            className="settings-input"
            maxLength={64}
            placeholder={kind === 'api' ? 'Ex.: API Anthropic' : 'Ex.: Cursor Pro'}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="spend-add__field" htmlFor={valueId}>
          <span>Valor por mês (US$)</span>
          <input
            id={valueId}
            className="settings-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={value}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
        </label>
      </div>
      <div className="spend-row__presets" role="group" aria-label="Valores rápidos">
        {MONTHLY_SPEND_PRESETS_USD.map((preset) => (
          <button
            key={preset}
            type="button"
            className="spend-chip"
            aria-pressed={parseUsdInput(value) === preset}
            onClick={() => {
              setValue(preset.toFixed(2));
              setError(null);
            }}
          >
            ${preset}
          </button>
        ))}
      </div>
      {error ? (
        <p className="spend-row__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <div className="spend-add__actions">
        <button type="button" className="settings-btn" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="settings-btn settings-btn--primary" disabled={saving}>
          Adicionar ao gasto mensal
        </button>
      </div>
    </form>
  );
}

export interface MonthlySpendCardProps {
  readonly quotaEntries: readonly ProviderQuotaEntry[];
  /** Equivalente de API dos últimos 30 dias, todos os projetos; null = sem leitura. */
  readonly apiEquivalentUsd: number | null;
}

export function MonthlySpendCard({ quotaEntries, apiEquivalentUsd }: MonthlySpendCardProps) {
  const titleId = useId();
  const spend = useSpendSettings();
  const [adding, setAdding] = useState(false);
  const detected = useMemo(() => detectedPlansFrom(quotaEntries), [quotaEntries]);
  const rows = useMemo(() => buildSpendRows(spend.entries, detected), [spend.entries, detected]);
  const summary = computeMonthlySpend(rows, apiEquivalentUsd);
  if (spend.status === 'unavailable') return null;

  const saveEntry = (entry: SpendEntry) => void spend.save(upsertSpendEntry(spend.entries, entry));
  const onCommit = (row: SpendRow, monthlyUsd: number) => saveEntry(toSpendEntry(row, { monthlyUsd }));
  const onToggle = (row: SpendRow) => saveEntry(toSpendEntry(row, { active: !row.active }));
  const onRemove = (row: SpendRow) => void spend.save(removeSpendEntry(spend.entries, row.id));
  const savings = summary.savingsUsd;

  return (
    <section className="spend-card" aria-labelledby={titleId} aria-busy={spend.status === 'loading'}>
      <header className="spend-card__head">
        <div>
          <h2 className="spend-card__title" id={titleId}>
            Gasto mensal real com IA
          </h2>
          <p className="spend-card__hint">
            O que você paga por mês em planos e API, em dólar. Planos detectados entram com o preço
            de lista; corrija o valor na linha quando o seu for outro.
          </p>
        </div>
        {!adding ? (
          <button type="button" className="settings-btn" onClick={() => setAdding(true)}>
            Adicionar assinatura ou API
          </button>
        ) : null}
      </header>

      <div className="spend-card__totals" role="status">
        <div className="spend-card__total">
          <span className="spend-card__total-label">Total mensal gasto com IA</span>
          <span className="spend-card__total-value">{formatUsdAmount(summary.totalUsd)}</span>
          <span className="spend-card__total-sub">
            planos {formatUsdAmount(summary.subscriptionsUsd)} · API {formatUsdAmount(summary.apiUsd)} por mês
          </span>
        </div>
        <div className="spend-card__total">
          <span className="spend-card__total-label">Equivalente em API (30 dias)</span>
          <span className="spend-card__total-value spend-card__total-value--muted">
            {summary.apiEquivalentUsd === null ? '—' : formatUsdAmount(summary.apiEquivalentUsd)}
          </span>
          <span className="spend-card__total-sub">todos os projetos, preço de API pública</span>
        </div>
        <div className="spend-card__total">
          <span className="spend-card__total-label">
            {savings !== null && savings < 0 ? 'Acima da API' : 'Economia frente à API'}
          </span>
          <span
            className={`spend-card__total-value ${
              savings !== null && savings > 0 ? 'spend-card__total-value--savings' : 'spend-card__total-value--muted'
            }`}
          >
            {savings === null ? '—' : formatUsdAmount(Math.abs(savings))}
          </span>
          <span className="spend-card__total-sub">
            {savings === null
              ? 'Sem leitura de consumo ainda'
              : savings < 0
                ? 'Os planos custaram mais do que o uso em API'
                : 'O que o uso custaria a mais em API'}
          </span>
        </div>
      </div>
      {summary.unpricedCount > 0 ? (
        <p className="spend-card__note">
          {summary.unpricedCount === 1
            ? '1 plano sem valor: informe o preço para fechar o total.'
            : `${summary.unpricedCount} planos sem valor: informe o preço para fechar o total.`}
        </p>
      ) : null}
      {spend.error ? (
        <p className="spend-row__error" role="alert">
          {spend.error}
        </p>
      ) : null}

      {adding ? (
        <AddSpendForm
          saved={spend.entries}
          saving={spend.saving}
          onCancel={() => setAdding(false)}
          onAdd={(entry) => {
            void spend.save([...spend.entries, entry]).then((ok) => {
              if (ok) setAdding(false);
            });
          }}
        />
      ) : null}

      {spend.status === 'error' ? (
        <p className="spend-row__error" role="alert">
          Não foi possível ler os valores salvos. Os planos detectados continuam abaixo.
        </p>
      ) : null}

      {rows.length === 0 && !adding ? (
        <EmptyState
          icon="bolt"
          className="spend-card__empty"
          title="Nenhum plano ou gasto informado"
          body={<p>Some aqui o que você paga em Claude, ChatGPT, Cursor, Grok, GLM ou API para ver o total do mês.</p>}
          action={
            <button type="button" className="settings-btn" onClick={() => setAdding(true)}>
              Adicionar assinatura
            </button>
          }
        />
      ) : (
        <ul className="spend-card__list">
          {rows.map((row) => (
            <SpendRowItem
              key={row.id}
              row={row}
              saving={spend.saving}
              onCommit={onCommit}
              onToggle={onToggle}
              onRemove={onRemove}
              onRestore={(target) => onRemove(target)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
