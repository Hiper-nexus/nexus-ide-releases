import { useEffect, useRef, useState } from 'react';

export function MissionDriverSettings() {
  const [isActive, setIsActive] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.settings
      .orchGet()
      .then((settings) => {
        if (!cancelled) setIsActive(settings.missionDriverActiveMode);
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

  return (
    <div aria-busy={isLoading || isSaving}>
      <div className="settings-section-heading settings-section-heading--with-count">
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
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
