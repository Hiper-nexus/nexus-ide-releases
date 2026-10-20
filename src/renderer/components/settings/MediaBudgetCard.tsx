import { useEffect, useId, useState } from 'react';
import { parseUsdInput } from '../../../shared/monthly-spend';
import type { MediaBudgetStateView } from '../../../shared/media-budget-types';

/**
 * Teto de gasto de mídia (F-1606): limite por missão e por dia que toda
 * ferramenta paga de mídia confere antes de chamar o provedor. Em branco =
 * sem teto. O gasto de hoje soma todos os projetos (preço de lista estimado).
 */

function formatUsd(value: number): string {
  return `US$ ${value.toFixed(2).replace('.', ',')}`;
}

function toField(value: number | null): string {
  return value === null ? '' : String(value).replace('.', ',');
}

export function MediaBudgetCard() {
  const bridge = typeof window !== 'undefined' ? window.nexus?.mediaBudget : undefined;
  const missionId = useId();
  const dayId = useId();
  const [state, setState] = useState<MediaBudgetStateView | null>(null);
  const [mission, setMission] = useState('');
  const [day, setDay] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .get()
      .then((view) => {
        if (cancelled) return;
        setState(view);
        setMission(toField(view.limits.perMissionUsd));
        setDay(toField(view.limits.perDayUsd));
      })
      .catch(() => {
        if (!cancelled) setMessage({ tone: 'danger', text: 'Não consegui ler o teto de gasto.' });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;

  async function save() {
    if (!bridge) return;
    const perMissionUsd = mission.trim() === '' ? null : parseUsdInput(mission);
    const perDayUsd = day.trim() === '' ? null : parseUsdInput(day);
    if ((mission.trim() !== '' && perMissionUsd === null) || (day.trim() !== '' && perDayUsd === null)) {
      setMessage({ tone: 'danger', text: 'Use um valor em dólar, como 5 ou 2,50, ou deixe em branco para sem teto.' });
      return;
    }
    setSaving(true);
    try {
      const result = await bridge.set({ perMissionUsd, perDayUsd });
      if (!result.ok) {
        setMessage({ tone: 'danger', text: result.error });
        return;
      }
      setState(result);
      setMessage({ tone: 'ok', text: 'Teto salvo. Vale para o próximo pedido pago.' });
    } catch {
      setMessage({ tone: 'danger', text: 'Não consegui salvar o teto.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="media-card my-voice" aria-labelledby="media-budget-title">
      <header className="my-voice__head">
        <h3 id="media-budget-title" className="arsenal-media-card__name">
          Teto de gasto de mídia
        </h3>
        <p className="settings-detail__hint">
          Imagem, vídeo, voz, narração e música param antes de chamar o serviço quando o pedido passaria do teto.
          O valor é o preço de lista estimado, cobrado na sua chave. Em branco, sem teto.
        </p>
      </header>
      <div className="settings-row">
        <label className="my-voice__field" htmlFor={missionId}>
          <span>Por missão (US$)</span>
          <input
            id={missionId}
            className="settings-input"
            inputMode="decimal"
            placeholder="sem teto"
            value={mission}
            onChange={(event) => setMission(event.target.value)}
          />
        </label>
        <label className="my-voice__field" htmlFor={dayId}>
          <span>Por dia, todos os projetos (US$)</span>
          <input
            id={dayId}
            className="settings-input"
            inputMode="decimal"
            placeholder="sem teto"
            value={day}
            onChange={(event) => setDay(event.target.value)}
          />
        </label>
        <button type="button" className="settings-btn settings-btn--primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Salvando…' : 'Salvar teto'}
        </button>
      </div>
      {state && <p className="settings-detail__hint">Gasto de mídia hoje: {formatUsd(state.spentTodayUsd)}.</p>}
      {message && (
        <p className={`prov__status media-key__status media-key__status--${message.tone}`} role={message.tone === 'danger' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
