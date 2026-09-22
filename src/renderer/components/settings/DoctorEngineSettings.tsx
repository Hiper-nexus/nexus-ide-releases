import { ProviderLogo } from '../ProviderLogo';
import { useEffect, useMemo, useState } from 'react';
import type { OrchSettings } from '../../../shared/settings-types';
import type { AdapterInfo } from '../../../shared/types';

type DoctorDefaults = Pick<OrchSettings, 'doctorAdapterId' | 'doctorModel' | 'doctorEffort'>;

const INITIAL: DoctorDefaults = {
  doctorAdapterId: 'auto',
  doctorModel: '',
  doctorEffort: 'auto',
};

export function DoctorEngineSettings() {
  const [value, setValue] = useState<DoctorDefaults>(INITIAL);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Diagnostics also renders in degraded/preload-recovery mode. Keep the
    // whole page usable when an older preload has not exposed these APIs yet.
    if (!window.nexus?.adapters || !window.nexus?.settings?.orchGet) {
      setBusy(false);
      setError('Catálogo de motores indisponível nesta sessão.');
      return;
    }
    const stop = window.nexus.adapters.onChanged((next) => !cancelled && setAdapters(next));
    void Promise.all([window.nexus.settings.orchGet(), window.nexus.adapters.list()])
      .then(([settings, next]) => {
        if (cancelled) return;
        setValue({
          doctorAdapterId: settings.doctorAdapterId,
          doctorModel: settings.doctorModel,
          doctorEffort: settings.doctorEffort,
        });
        setAdapters(next);
        setBusy(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Falha ao carregar o motor do Doctor.');
        setBusy(false);
      });
    return () => { cancelled = true; stop(); };
  }, []);

  const installed = useMemo(
    // Today Grok exposes the strict schema/check-mode contract used by this
    // diagnostic path. Auto remains provider-neutral through the brain chain.
    () => adapters.filter((adapter) => adapter.installed && adapter.id === 'grok'),
    [adapters],
  );
  const selected = installed.find((adapter) => adapter.id === value.doctorAdapterId);
  const configured = adapters.find((adapter) => adapter.id === value.doctorAdapterId);
  const unavailable = value.doctorAdapterId !== 'auto' && !selected;

  const save = async (patch: Partial<DoctorDefaults>) => {
    const previous = value;
    const optimistic = { ...value, ...patch };
    setValue(optimistic);
    setBusy(true);
    setError(null);
    try {
      const saved = await window.nexus.settings.orchSet(patch);
      setValue({
        doctorAdapterId: saved.doctorAdapterId,
        doctorModel: saved.doctorModel,
        doctorEffort: saved.doctorEffort,
      });
    } catch (cause) {
      setValue(previous);
      setError(cause instanceof Error ? cause.message : 'Falha ao salvar o motor do Doctor.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-orchestrator" aria-busy={busy}>
      <div className="settings-orchestrator__head">
        <div>
          <h3 className="settings-orchestrator__title">Assistente de diagnóstico</h3>
          <p className="settings-orchestrator__summary">
            Analisa problemas do app. As recuperações seguras são executadas pelo próprio Nexus.
          </p>
        </div>
        <span className={`settings-chip ${unavailable ? 'settings-chip--warn' : 'settings-chip--ok'}`}>
          {configured && <ProviderLogo adapterId={configured.id} label={configured.label} size="xs" />}
          {value.doctorAdapterId === 'auto' ? 'Automático · recomendado' : unavailable ? 'Indisponível · fallback automático' : selected?.label}
        </span>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="settings-orchestrator__grid">
        <label className="settings-field">
          Motor
          <select className="settings-input" value={value.doctorAdapterId} disabled={busy}
            onChange={(event) => void save({ doctorAdapterId: event.target.value, doctorModel: '', doctorEffort: event.target.value === 'grok' ? 'max' : 'auto' })}>
            <option value="auto">Automático (melhor disponível)</option>
            {unavailable && <option value={value.doctorAdapterId}>{configured?.label ?? value.doctorAdapterId} (indisponível)</option>}
            {installed.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.label}</option>)}
          </select>
        </label>
        <label className="settings-field">
          Modelo
          <select className="settings-input" value={value.doctorModel} disabled={busy || !selected}
            onChange={(event) => void save({ doctorModel: event.target.value })}>
            <option value="">Padrão do provider{selected?.models.default ? ` (${selected.models.default})` : ''}</option>
            {selected?.models.list.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
        <label className="settings-field">
          Esforço
          <select className="settings-input" value={value.doctorEffort} disabled={busy || value.doctorAdapterId === 'auto'}
            onChange={(event) => void save({ doctorEffort: event.target.value as DoctorDefaults['doctorEffort'] })}>
            <option value="max">Máximo suportado</option>
            <option value="auto">Automático</option>
            <option value="high">Alto</option>
            <option value="medium">Médio</option>
            <option value="low">Baixo</option>
          </select>
        </label>
      </div>
      <p className="settings-field__note">
        Se o serviço escolhido falhar, o Nexus tenta outra opção disponível.
      </p>
    </div>
  );
}
