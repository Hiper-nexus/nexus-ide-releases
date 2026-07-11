import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccountStore } from '../state/account-store';
import { useSettingsStore } from '../state/settings-store';
import { PixelIcon } from './PixelIcon';

/**
 * Compact multi-account control for the Activity Rail footer / chrome.
 * Activates a saved account or deep-links into Settings → Providers.
 */
export function AccountSwitcher({ compact = false }: { compact?: boolean }) {
  const accounts = useAccountStore((s) => s.accounts);
  const activate = useAccountStore((s) => s.activate);
  const openDrawer = useSettingsStore((s) => s.openDrawer);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const active = useMemo(
    () => accounts.find((a) => a.active) ?? null,
    [accounts],
  );
  const onCooldown = accounts.filter((a) => a.onCooldown);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = active
    ? active.label
    : accounts.length === 0
      ? 'Conta CLI'
      : 'Nenhuma ativa';
  const sub = active
    ? `${active.adapterId}${active.onCooldown ? ' · cooldown' : ''}`
    : accounts.length > 0
      ? `${accounts.length} salva${accounts.length === 1 ? '' : 's'}`
      : 'configurar';

  return (
    <div className={`account-switcher ${compact ? 'account-switcher--compact' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="account-switcher__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Trocar conta de CLI (Codex, Claude, Grok…)"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-switcher__dot" data-state={active ? (active.onCooldown ? 'cool' : 'on') : 'off'} />
        <span className="account-switcher__text">
          <span className="account-switcher__label">{label}</span>
          {!compact && <span className="account-switcher__sub">{sub}</span>}
        </span>
        <span className="account-switcher__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="account-switcher__menu" role="menu">
          {accounts.length === 0 ? (
            <p className="account-switcher__empty">
              Nenhuma conta salva. Adicione Claude, Codex ou Grok em Config → Providers.
            </p>
          ) : (
            accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                className={`account-switcher__item ${a.active ? 'account-switcher__item--active' : ''}`}
                disabled={busy || a.onCooldown}
                title={
                  a.onCooldown
                    ? `Em cooldown${a.lastError ? `: ${a.lastError}` : ''}`
                    : `Ativar ${a.label}`
                }
                onClick={() => {
                  setBusy(true);
                  setNote(null);
                  void activate(a.id)
                    .then((r) => {
                      if (!r.ok) setNote(r.error ?? 'Falha ao ativar');
                      else setOpen(false);
                    })
                    .catch((e) => {
                      setNote(e instanceof Error ? e.message : 'Falha ao ativar');
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <span className="account-switcher__item-main">
                  <span className="account-switcher__item-label">{a.label}</span>
                  <span className="account-switcher__item-meta">
                    {a.adapterId}
                    {a.mode === 'subscription' ? ' · sub' : ` · ${a.upstream || 'key'}`}
                    {a.onCooldown ? ' · cooldown' : ''}
                    {a.active ? ' · ativa' : ''}
                  </span>
                </span>
              </button>
            ))
          )}
          {onCooldown.length > 0 && (
            <p className="account-switcher__hint">
              {onCooldown.length} em cooldown (failover automático quando o limite passar)
            </p>
          )}
          {note && <p className="account-switcher__err">{note}</p>}
          <button
            type="button"
            className="account-switcher__item account-switcher__item--link"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openDrawer();
            }}
          >
            <PixelIcon name="config" size={12} />
            <span>Gerir contas em Config</span>
          </button>
        </div>
      )}
    </div>
  );
}
