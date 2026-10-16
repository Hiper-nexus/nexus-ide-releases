import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SpendEntry,
  SpendSettings,
  SpendSettingsPatch,
} from '../../shared/settings-types';

export type SpendSettingsStatus = 'unavailable' | 'loading' | 'ready' | 'error';

interface SpendApi {
  spendGet?: () => Promise<SpendSettings>;
  spendSet?: (patch: SpendSettingsPatch) => Promise<SpendSettings>;
  onSpendChanged?: (cb: (spend: SpendSettings) => void) => () => void;
}

function spendApi(): SpendApi | undefined {
  return (window.nexus as unknown as { settings?: SpendApi } | undefined)?.settings;
}

export interface SpendSettingsState {
  readonly status: SpendSettingsStatus;
  readonly entries: readonly SpendEntry[];
  readonly saving: boolean;
  /** Última gravação recusada; a lista já voltou ao valor salvo. */
  readonly error: string | null;
  /** Grava a lista inteira. Otimista: a tela muda já e volta se o Main recusar. */
  readonly save: (entries: readonly SpendEntry[]) => Promise<boolean>;
}

/**
 * Gasto mensal real (`settings.spend`). Autoridade: o Main valida e persiste
 * em ~/.nexus/settings.json; outra janela que grave chega por
 * `onSpendChanged`. Sem a ponte (testes, embeds) o cartão some.
 */
export function useSpendSettings(): SpendSettingsState {
  const [status, setStatus] = useState<SpendSettingsStatus>(() =>
    spendApi()?.spendGet ? 'loading' : 'unavailable',
  );
  const [entries, setEntries] = useState<readonly SpendEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = useRef<readonly SpendEntry[]>([]);

  useEffect(() => {
    const api = spendApi();
    if (!api?.spendGet) {
      setStatus('unavailable');
      return undefined;
    }
    let cancelled = false;
    const apply = (spend: SpendSettings) => {
      if (cancelled) return;
      confirmed.current = spend.entries;
      setEntries(spend.entries);
      setStatus('ready');
    };
    void api
      .spendGet()
      .then(apply)
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    const off = api.onSpendChanged?.(apply) ?? (() => {});
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const save = useCallback(async (next: readonly SpendEntry[]): Promise<boolean> => {
    const api = spendApi();
    if (!api?.spendSet) return false;
    setEntries(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await api.spendSet({ entries: [...next] });
      confirmed.current = saved.entries;
      setEntries(saved.entries);
      const accepted = JSON.stringify(saved.entries) === JSON.stringify(next);
      if (!accepted) setError('O valor não foi aceito. Use um número entre 0 e 100.000.');
      return accepted;
    } catch {
      setEntries(confirmed.current);
      setError('Não foi possível salvar. Tente de novo.');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { status, entries, saving, error, save };
}
