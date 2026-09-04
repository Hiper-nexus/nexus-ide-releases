import { useMemo } from 'react';
import { ProviderLogo } from '../ProviderLogo';
import { shortWindowsLine } from '../../lib/quota-display';
import {
  rankModelOptions,
  type RankedModelOption,
} from '../../lib/model-picker-rank';
import { useAdapterStore } from '../../state/adapter-store';
import { useProviderStore } from '../../state/provider-store';
import { useQuotaStore } from '../../state/quota-store';

export interface ModelPickerSelection {
  adapterId: string;
  model: string;
}

export interface ModelPickerProps {
  options: readonly RankedModelOption[];
  quotaLineByAdapterId?: Readonly<Record<string, string>>;
  selected?: ModelPickerSelection | null;
  onSelect(option: RankedModelOption): void;
  id?: string;
  /** Rótulo amigável por modelo (ex.: "Claude Opus 5 · claude-opus-5"). */
  formatModelName?: (adapterId: string, model: string) => string;
}

interface ProviderGroup {
  adapterId: string;
  adapterLabel: string;
  adapterIcon: string;
  options: RankedModelOption[];
}

function groupByProvider(
  options: readonly RankedModelOption[],
): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const option of options) {
    const group = groups.get(option.adapterId);
    if (group) {
      group.options.push(option);
    } else {
      groups.set(option.adapterId, {
        adapterId: option.adapterId,
        adapterLabel: option.adapterLabel,
        adapterIcon: option.adapterIcon,
        options: [option],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Seletor unificado de LLM estilo Orca: um grupo por provider com logo,
 * linha de uso (ex.: "5 Horas 35% · Semanal 41%") e modelos ordenados por
 * sessão pronta → custo → quota livre. Modelos sem sessão aparecem
 * desabilitados com o motivo (comando de login), nunca somem em silêncio.
 */
export function ModelPicker({
  options,
  quotaLineByAdapterId,
  selected,
  onSelect,
  id = 'model-picker',
  formatModelName,
}: ModelPickerProps) {
  const groups = useMemo(() => groupByProvider(options), [options]);
  if (groups.length === 0) {
    return (
      <p className="model-picker__empty" role="status">
        Nenhuma CLI instalada — instale Claude ou Codex para escolher um modelo.
      </p>
    );
  }
  return (
    <div className="model-picker" role="radiogroup" aria-label="Escolher modelo">
      {groups.map((group) => {
        const quotaLine = quotaLineByAdapterId?.[group.adapterId];
        return (
          <section
            key={group.adapterId}
            className="model-picker__provider"
            aria-label={group.adapterLabel}
          >
            <header className="model-picker__provider-head">
              <ProviderLogo
                adapterId={group.adapterId}
                label={group.adapterLabel}
                fallback={group.adapterIcon}
                size="sm"
              />
              <span className="model-picker__provider-name">
                {group.adapterLabel}
              </span>
              {quotaLine ? (
                <span className="model-picker__provider-quota">{quotaLine}</span>
              ) : null}
            </header>
            <ul className="model-picker__models">
              {group.options.map((option) => {
                const isSelected =
                  selected?.adapterId === option.adapterId &&
                  selected?.model === option.model;
                const disabled = option.ready === false;
                const displayName =
                  formatModelName?.(option.adapterId, option.model) ??
                  option.model;
                return (
                  <li key={option.model}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      disabled={disabled}
                      id={
                        isSelected ? `${id}--selected` : undefined
                      }
                      className={`model-picker__model${
                        isSelected ? ' model-picker__model--selected' : ''
                      }`}
                      title={option.reason ?? `${option.adapterLabel} · ${option.model}`}
                      aria-label={
                        disabled
                          ? `${displayName} indisponível: ${option.reason ?? 'sessão necessária'}`
                          : `${displayName}${option.isDefault ? ' (padrão)' : ''}`
                      }
                      onClick={() => onSelect(option)}
                    >
                      <span className="model-picker__model-name">
                        {displayName}
                      </span>
                      {option.isDefault ? (
                        <span className="model-picker__model-default">padrão</span>
                      ) : null}
                      {disabled && option.reason ? (
                        <span className="model-picker__model-reason">
                          {option.reason}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Versão ligada aos stores (adapters + providers + quota). */
export function ModelPickerConnected({
  selected,
  onSelect,
  id,
  formatModelName,
}: {
  selected?: ModelPickerSelection | null;
  onSelect(option: RankedModelOption): void;
  id?: string;
  formatModelName?: (adapterId: string, model: string) => string;
}) {
  const adapters = useAdapterStore((s) => s.adapters);
  const providers = useProviderStore((s) => s.providers);
  const quotaEntries = useQuotaStore((s) => s.snapshot.entries);
  const options = useMemo(
    () => rankModelOptions({ adapters, providers, quotaEntries }),
    [adapters, providers, quotaEntries],
  );
  const quotaLineByAdapterId = useMemo(() => {
    const lines: Record<string, string> = {};
    for (const entry of quotaEntries) {
      if (lines[entry.adapterId] === undefined) {
        lines[entry.adapterId] = shortWindowsLine(entry);
      }
    }
    return lines;
  }, [quotaEntries]);
  return (
    <ModelPicker
      options={options}
      quotaLineByAdapterId={quotaLineByAdapterId}
      selected={selected}
      onSelect={onSelect}
      id={id}
      formatModelName={formatModelName}
    />
  );
}
