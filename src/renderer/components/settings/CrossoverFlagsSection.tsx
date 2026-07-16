import { useEffect, useState } from 'react';
import type { ProductApi } from '../../../shared/product-api';
import {
  CROSSOVER_FLAG_WARNINGS,
  CROSSOVER_TOGGLEABLE_FLAG_IDS,
  type CrossoverFlagBridge,
} from '../../../shared/crossover-flags';

/**
 * Crossover feature-flag toggles (oh-my-pi integration).
 *
 * Surfaces the two capabilities that ship default OFF and fail-closed —
 * `feature.remote.relayTransport` and `feature.memory.workspaceMemory` — with a
 * conscious toggle, the registry description, and an extra "com cuidado" warning
 * per flag. Toggling flips a PERSISTED override via the main registry (never a
 * default change), and the response echoes the RESOLVED state so policy
 * (kill-switch / channel) that refuses an override is shown honestly.
 */

interface FlagRow {
  id: string;
  enabled: boolean;
  reason: string;
  owner: string;
  description: string;
}

function readField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function toRow(item: unknown): FlagRow | null {
  if (typeof item !== 'object' || item === null) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.id !== 'string' || typeof rec.enabled !== 'boolean') return null;
  const def =
    typeof rec.definition === 'object' && rec.definition !== null
      ? (rec.definition as Record<string, unknown>)
      : {};
  return {
    id: rec.id,
    enabled: rec.enabled,
    reason: typeof rec.reason === 'string' ? rec.reason : 'default',
    owner: readField(def, 'owner') || '—',
    description: readField(def, 'description'),
  };
}

function crossoverProduct(): (ProductApi & Partial<CrossoverFlagBridge>) | null {
  const product = window.nexus?.product;
  if (!product) return null;
  return product as ProductApi & Partial<CrossoverFlagBridge>;
}

export function CrossoverFlagsSection() {
  const [rows, setRows] = useState<FlagRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const product = crossoverProduct();
      if (!product) return;
      try {
        const list = await product.flagsList();
        const filtered = list
          .map(toRow)
          .filter(
            (row): row is FlagRow =>
              row !== null && CROSSOVER_TOGGLEABLE_FLAG_IDS.includes(row.id),
          )
          .sort(
            (a, b) =>
              CROSSOVER_TOGGLEABLE_FLAG_IDS.indexOf(a.id) -
              CROSSOVER_TOGGLEABLE_FLAG_IDS.indexOf(b.id),
          );
        if (!cancelled) setRows(filtered);
      } catch {
        if (!cancelled) setError('Não foi possível ler as flags.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (row: FlagRow, next: boolean) => {
    const setOverride = crossoverProduct()?.flagsSetOverride;
    if (!setOverride) {
      setError('Toggle indisponível — recarregue o app para carregar a bridge.');
      return;
    }
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const result = await setOverride({ id: row.id, enabled: next });
      setRows((prev) =>
        prev.map((r) =>
          r.id === result.id
            ? { ...r, enabled: result.enabled, reason: result.reason }
            : r,
        ),
      );
      if (!result.persisted) {
        setNotice(
          'Override aplicado nesta sessão, mas não pôde ser gravado — não sobrevive a um restart.',
        );
      } else if (next && !result.enabled) {
        // Policy (kill-switch / channel) refused the override.
        setNotice(`A flag continua desligada por política (${result.reason}).`);
      }
    } catch {
      setError('Falha ao alternar a flag.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <h3 className="settings-detail__title">Flags do crossover oh-my-pi</h3>
      <p className="settings-field__note">
        Capacidades novas, default OFF (fail-closed). Ligue conscientemente — cada
        uma persiste como override e é reversível a qualquer momento.
      </p>
      {error ? (
        <p className="settings-field__note" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="settings-field__note" role="status">
          {notice}
        </p>
      ) : null}
      {rows.length === 0 && !error ? (
        <p className="settings-field__note">
          Nenhuma flag de crossover disponível neste build.
        </p>
      ) : (
        rows.map((row) => (
          <label key={row.id} className="settings-toggle-card">
            <span className="settings-toggle-card__copy">
              <strong>{row.id}</strong>
              <span className="settings-field__note">
                owner: {row.owner} · estado: {row.reason}
              </span>
              {row.description ? <span>{row.description}</span> : null}
              {CROSSOVER_FLAG_WARNINGS[row.id] ? (
                <span className="settings-field__note">
                  ⚠ {CROSSOVER_FLAG_WARNINGS[row.id]}
                </span>
              ) : null}
            </span>
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={busyId === row.id}
              aria-label={`Ativar ${row.id}`}
              onChange={(e) => void toggle(row, e.target.checked)}
            />
          </label>
        ))
      )}
    </section>
  );
}
