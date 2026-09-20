import { useEffect, useRef, useState } from 'react';
import type { OrchSettings } from '../../../shared/settings-types';

type AgentRestorePolicy = OrchSettings['agentRestorePolicy'];

const RESTORE_OPTIONS: {
  value: AgentRestorePolicy;
  label: string;
  hint: string;
}[] = [
  {
    value: 'ask',
    label: 'Perguntar para agentes avulsos',
    hint: 'Missões retomam sozinhas; só terminais de agente abertos fora delas pedem confirmação.',
  },
  {
    value: 'pause',
    label: 'Pausar agentes avulsos',
    hint: 'Mantém terminais independentes parados, sem interromper o autopiloto de missões.',
  },
  {
    value: 'resume',
    label: 'Retomar tudo automaticamente',
    hint: 'Padrão: agentes avulsos também voltam a trabalhar sem diálogo.',
  },
];

export function AgentSessionSettings() {
  const [autoResponderEnabled, setAutoResponderEnabled] = useState(true);
  const [restorePolicy, setRestorePolicy] =
    useState<AgentRestorePolicy>('resume');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.settings
      .orchGet()
      .then((settings) => {
        if (!cancelled) {
          setAutoResponderEnabled(settings.cliPromptAutoResponderEnabled ?? true);
          setRestorePolicy(settings.agentRestorePolicy ?? 'resume');
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Falha ao carregar as preferências de sessão.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveRestorePolicy = async (next: AgentRestorePolicy) => {
    if (savingRef.current) return;
    const previous = restorePolicy;
    savingRef.current = true;
    setRestorePolicy(next);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await window.nexus.settings.orchSet({
        agentRestorePolicy: next,
      });
      setRestorePolicy(saved.agentRestorePolicy ?? 'resume');
    } catch (cause) {
      setRestorePolicy(previous);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Falha ao salvar a política de retoma.',
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const saveAutoResponder = async (next: boolean) => {
    if (savingRef.current) return;
    const previous = autoResponderEnabled;
    savingRef.current = true;
    setAutoResponderEnabled(next);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await window.nexus.settings.orchSet({
        cliPromptAutoResponderEnabled: next,
      });
      setAutoResponderEnabled(saved.cliPromptAutoResponderEnabled ?? true);
    } catch (cause) {
      setAutoResponderEnabled(previous);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Falha ao salvar o autoaceite de prompts.',
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div aria-busy={isLoading || isSaving}>
      <div className="settings-section-heading settings-section-heading--with-count">
        <h4>Retoma de agentes</h4>
        <span className="settings-chip" aria-live="polite">
          Multi-SO: {restorePolicy === 'ask' ? 'perguntar' : restorePolicy}
        </span>
      </div>
      <p className="settings-field__note">
        Missões em andamento retomam automaticamente pela autoridade persistida
        do Main em <strong>macOS, Linux e Windows</strong>. Esta preferência
        controla somente agentes avulsos.
      </p>
      <div className="settings-toggle-list" role="radiogroup" aria-label="Política de retoma">
        {RESTORE_OPTIONS.map((opt) => (
          <label key={opt.value} className="settings-toggle-row">
            <span className="settings-toggle-row__copy">
              <strong>{opt.label}</strong>
              <span>{opt.hint}</span>
            </span>
            <input
              type="radio"
              name="agent-restore-policy"
              value={opt.value}
              checked={restorePolicy === opt.value}
              disabled={isLoading || isSaving}
              onChange={() => void saveRestorePolicy(opt.value)}
            />
            <span className="settings-toggle-row__control" aria-hidden="true" />
          </label>
        ))}
      </div>

      <div className="settings-section-heading settings-section-heading--with-count">
        <h4>Prompts de boot</h4>
        <span
          className={`settings-chip ${autoResponderEnabled ? 'settings-chip--ok' : ''}`}
          aria-live="polite"
        >
          {autoResponderEnabled ? 'Autoaceite restrito' : 'Kill switch ativo'}
        </span>
      </div>
      <div className="settings-toggle-list">
        <label className="settings-toggle-row">
          <span className="settings-toggle-row__copy">
            <strong>Autoaceitar prompts conhecidos</strong>
            <span>
              Responde apenas assinaturas fixas de confiança/boot do adapter.
              Desative para bloquear imediatamente todo keypress automático.
            </span>
          </span>
          <input
            type="checkbox"
            aria-label="Autoaceitar prompts conhecidos"
            checked={autoResponderEnabled}
            disabled={isLoading || isSaving}
            onChange={(event) => void saveAutoResponder(event.target.checked)}
          />
          <span className="settings-toggle-row__control" aria-hidden="true" />
        </label>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
