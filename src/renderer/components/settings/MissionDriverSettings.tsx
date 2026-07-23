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
    label: 'Perguntar (recomendado)',
    hint: 'Pausa agentes e pede confirmação — igual em Mac, Linux e Windows.',
  },
  {
    value: 'pause',
    label: 'Sempre pausar',
    hint: 'Nunca reinicia sozinho; você retoma no rail de missões.',
  },
  {
    value: 'resume',
    label: 'Retomar automaticamente',
    hint: 'Comportamento antigo: agentes voltam a trabalhar sem diálogo.',
  },
];

export function MissionDriverSettings() {
  const [isActive, setIsActive] = useState(false);
  const [autoResponderEnabled, setAutoResponderEnabled] = useState(true);
  const [restorePolicy, setRestorePolicy] =
    useState<AgentRestorePolicy>('ask');
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
          setIsActive(settings.missionDriverActiveMode);
          setAutoResponderEnabled(settings.cliPromptAutoResponderEnabled ?? true);
          setRestorePolicy(settings.agentRestorePolicy ?? 'ask');
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Falha ao carregar o Mission Driver.',
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

  const save = async (next: boolean) => {
    if (savingRef.current) return;
    const previous = isActive;
    savingRef.current = true;
    setIsActive(next);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await window.nexus.settings.orchSet({
        missionDriverActiveMode: next,
      });
      setIsActive(saved.missionDriverActiveMode);
    } catch (cause) {
      setIsActive(previous);
      setError(
        cause instanceof Error
          ? cause.message
          : 'Falha ao salvar o Mission Driver.',
      );
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

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
      setRestorePolicy(saved.agentRestorePolicy ?? 'ask');
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
      <p className="settings-section-desc" style={{ marginBottom: 12 }}>
        Ao abrir o app ou um workspace com missões salvas, o Nexus usa a mesma
        regra em <strong>macOS, Linux e Windows</strong> — sem auto-trabalho
        silencioso por padrão.
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
          </label>
        ))}
      </div>

      <div className="settings-section-heading settings-section-heading--with-count" style={{ marginTop: 20 }}>
        <h4>Ralph loop</h4>
        <span
          className={`settings-chip ${isActive ? 'settings-chip--ok' : ''}`}
          aria-live="polite"
        >
          Próxima inicialização: {isActive ? 'Ativo' : 'Shadow'}
        </span>
      </div>
      <div className="settings-toggle-list">
        <label className="settings-toggle-row">
          <span className="settings-toggle-row__copy">
            <strong>Mission Driver autônomo</strong>
            <span>
              Avança passos com PREVC, sinaliza stalls e recupera panes usando
              orçamento persistente e backoff.
            </span>
          </span>
          <input
            type="checkbox"
            aria-label="Ativar Mission Driver"
            checked={isActive}
            disabled={isLoading || isSaving}
            onChange={(event) => void save(event.target.checked)}
          />
          <span className="settings-toggle-row__control" aria-hidden="true" />
        </label>
      </div>
      <p className="settings-field__note">
        Esta tela configura a próxima inicialização; o runtime atual não muda
        até reiniciar o Nexus. Shadow apenas observa; Ativo executa ações
        protegidas pelos gates e limites do Ralph.
      </p>

      <div className="settings-section-heading settings-section-heading--with-count" style={{ marginTop: 20 }}>
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
