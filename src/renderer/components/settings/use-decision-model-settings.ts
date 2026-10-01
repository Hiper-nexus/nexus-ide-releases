import { useEffect, useRef, useState } from 'react';
import type { DecisionModelStatus } from '../../../shared/decision-models';

export function useDecisionModelSettings() {
  const [status, setStatus] = useState<DecisionModelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const supported = Boolean(window.nexus?.decisionModels);
  useEffect(() => {
    let active = true;
    if (supported) void window.nexus.decisionModels.status().then(value => {
      if (active) setStatus(value);
    }).catch(() => { if (active) setError('Não consegui carregar os modelos de decisão.'); });
    return () => { active = false; };
  }, [supported]);

  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    if (lock.current || !supported) return false;
    lock.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      setStatus(await window.nexus.decisionModels.status());
      setNotice(success);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não consegui salvar esta configuração.');
      return false;
    } finally { lock.current = false; setBusy(false); }
  }
  return { status, supported, busy, error, notice, run, setError };
}
