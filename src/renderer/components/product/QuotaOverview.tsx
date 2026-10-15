import { useEffect, useId, useRef, useState } from 'react';
import type { ProviderQuotaEntry, QuotaWindow } from '../../../shared/quota-types';
import { maskFleetLabel } from '../../../main/quota/smart-pick';
import { formatResetCountdown, windowDisplay } from '../../lib/quota-display';
import { OverlayLayer } from '../../overlay/overlay-layer';
import { useQuotaStore } from '../../state/quota-store';
import { PixelIcon } from '../PixelIcon';
import { ProviderLogo } from '../ProviderLogo';
import { trapDialogTabKey } from '../settings/settings-dialog-focus';

type Filter = 'all' | 'measured' | 'attention';

function measured(entry: ProviderQuotaEntry): boolean {
  return entry.readHint !== 'identity-mismatch' && entry.windows.some(
    (window) => windowDisplay(window).tone !== 'unknown' && window.confidence !== 'low' && window.source === 'provider-api',
  );
}

function readingState(entry: ProviderQuotaEntry): string {
  if (entry.readHint === 'auth-expired' || entry.readHint === 'identity-mismatch') return 'Entrar novamente';
  if (entry.onCooldown) return 'Pausa temporária';
  if (entry.readHint === 'quota-key-required') return 'Conectar fonte de cota';
  if (entry.readHint === 'no-credential') return 'Conectar conta';
  if (entry.readHint === 'cli-missing') return 'CLI não encontrada';
  return measured(entry) ? 'Leitura disponível' : 'Sem leitura';
}

function Meter({ window, now }: { window: QuotaWindow; now: number }) {
  const view = windowDisplay(window);
  const known = view.tone !== 'unknown';
  const estimated = window.confidence === 'low' || window.source !== 'provider-api';
  const countdown = formatResetCountdown(window.resetsAt, now);
  return (
    <div className={`quota-meter quota-meter--${estimated ? 'unknown' : view.tone}`}>
      <div className="quota-meter__heading">
        <span>{window.label}</span>
        <strong>{view.percentLabel}<small> usado</small></strong>
      </div>
      <div
        className="quota-meter__segments"
        role={known ? 'meter' : 'img'}
        aria-label={`${window.label}${known ? (estimated ? ' · estimado' : ' · usado') : ' · sem leitura'}`}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? 100 : undefined}
        aria-valuenow={known ? view.barRatio * 100 : undefined}
      >
        {known && <span style={{ transform: `scaleX(${view.barRatio})` }} />}
      </div>
      <div className="quota-meter__meta">
        <span>{estimated ? 'Estimado' : known ? 'Medido' : 'Não informado'}</span>
        {countdown && <span><PixelIcon name="restart" size={10} /> {countdown}</span>}
      </div>
    </div>
  );
}

function Account({ entry, now, onOpenUsage }: {
  entry: ProviderQuotaEntry; now: number; onOpenUsage(): void;
}) {
  const windows = entry.readHint === 'identity-mismatch' ? [] : entry.windows.filter((window) => window.usedRatio !== null);
  const needsAttention = !measured(entry) || entry.onCooldown || entry.readHint === 'auth-expired';
  return (
    <article className={`quota-overview__account${needsAttention ? ' quota-overview__account--attention' : ''}`}>
      <header>
        <ProviderLogo adapterId={entry.adapterId} label={entry.adapterId} size="md" />
        <h3>{maskFleetLabel(entry.label)}</h3>
        {entry.active && <span className="quota-overview__active">Ativa</span>}
      </header>
      {windows.map((window) => <Meter key={`${window.kind}:${window.label}`} window={window} now={now} />)}
      {needsAttention && (
        <div className="quota-overview__connection">
          <span><PixelIcon name="info" size={12} /> {readingState(entry)}</span>
          <button type="button" onClick={onOpenUsage}>Resolver <PixelIcon name="arrow-right" size={10} /></button>
        </div>
      )}
    </article>
  );
}

export function QuotaOverview({ entries, now, onClose, onOpenUsage }: {
  entries: readonly ProviderQuotaEntry[]; now: number; onClose(): void; onOpenUsage(): void;
}) {
  const dialogId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreOpener = useRef(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const status = useQuotaStore((state) => state.status);
  const measuredCount = entries.filter(measured).length;
  const attentionCount = entries.filter((entry) => !measured(entry) || entry.onCooldown || entry.readHint === 'auth-expired').length;
  const providers = new Set(entries.map((entry) => entry.adapterId)).size;
  const shown = entries.filter((entry) => {
    if (!entry.label.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim())) return false;
    if (filter === 'measured') return measured(entry);
    if (filter === 'attention') return !measured(entry) || entry.onCooldown || entry.readHint === 'auth-expired';
    return true;
  });

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (restoreOpener.current && previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  const openSettings = () => { restoreOpener.current = false; onClose(); onOpenUsage(); };
  const refresh = () => { closeRef.current?.focus(); void useQuotaStore.getState().refresh(); };
  return (
    <OverlayLayer>
      <div className="quota-overview__backdrop overlay-scrim-glass overlay-scrim-enter" onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
        <section ref={dialogRef} id={dialogId} className="quota-overview overlay-enter"
          role="dialog" aria-modal="true" aria-label="Cotas das suas IAs" tabIndex={-1}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') { event.preventDefault(); onClose(); }
            if (event.key === 'Tab' && dialogRef.current && trapDialogTabKey(dialogRef.current, event.shiftKey)) event.preventDefault();
          }}>
          <header className="quota-overview__header">
            <div><h2>Cotas das suas IAs</h2><p>{providers} provedores · {entries.length} contas</p></div>
            <div className="quota-overview__actions">
              <button type="button" disabled={status === 'loading'} onClick={refresh}>
                <PixelIcon name="refresh" size={14} /> {status === 'loading' ? 'Atualizando…' : 'Atualizar'}
              </button>
              <button ref={closeRef} type="button" aria-label="Fechar cotas" onClick={onClose}><PixelIcon name="close" size={16} /></button>
            </div>
          </header>
          <div className="quota-overview__toolbar">
            <div className="quota-overview__filters" role="group" aria-label="Filtrar contas">
              {([{ id: 'all', label: 'Todas', count: entries.length }, { id: 'measured', label: 'Com leitura', count: measuredCount },
                { id: 'attention', label: 'Resolver', count: attentionCount }] as const).map((item) => (
                <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label} <span>{item.count}</span></button>
              ))}
            </div>
            <label className="quota-overview__search"><PixelIcon name="search" size={14} /><input aria-label="Buscar conta ou provedor" placeholder="Buscar conta ou provedor" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          </div>
          {status === 'error' && <p className="quota-overview__error" role="status">Não foi possível atualizar. Tente novamente.</p>}
          <div className="quota-overview__grid">
            {shown.map((entry) => <Account key={entry.id} entry={entry} now={now} onOpenUsage={openSettings} />)}
            {shown.length === 0 && <div className="quota-overview__empty"><PixelIcon name="search" size={24} /><p>Nenhuma conta neste filtro.</p><button type="button" onClick={() => { setFilter('all'); setSearch(''); }}>Ver todas</button></div>}
          </div>
          <footer className="quota-overview__footer"><span>Consumo por conta · dados do provedor</span><button type="button" onClick={openSettings}>Uso e cotas <PixelIcon name="arrow-right" size={12} /></button></footer>
        </section>
      </div>
    </OverlayLayer>
  );
}
