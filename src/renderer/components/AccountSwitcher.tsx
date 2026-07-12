import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccountStore } from '../state/account-store';
import { useSettingsStore } from '../state/settings-store';
import {
  restartPanesForPendingAccount,
} from '../orch/account-restart-controller';
import { PixelIcon } from './PixelIcon';

/**
 * Compact multi-account control (Orca-style hot-swap chip).
 * Groups by adapter, activates a saved account, surfaces quota/cooldown,
 * and offers restart of live panes after a switch.
 */
export function AccountSwitcher({
  compact = false,
  adapterFilter,
}: {
  compact?: boolean;
  /** When set, only show accounts for this provider (status-bar chip). */
  adapterFilter?: string;
}) {
  const accounts = useAccountStore((s) => s.accounts);
  const quota = useAccountStore((s) => s.quota);
  const activate = useAccountStore((s) => s.activate);
  const restartAdapterId = useAccountStore((s) => s.restartAdapterId);
  const restartLabel = useAccountStore((s) => s.restartLabel);
  const clearRestartNotice = useAccountStore((s) => s.clearRestartNotice);
  const openDrawer = useSettingsStore((s) => s.openDrawer);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () =>
      adapterFilter
        ? accounts.filter((a) => a.adapterId === adapterFilter)
        : accounts,
    [accounts, adapterFilter],
  );

  const active = useMemo(
    () => visible.find((a) => a.active) ?? null,
    [visible],
  );
  const onCooldown = visible.filter((a) => a.onCooldown);

  const quotaById = useMemo(() => {
    const map = new Map(quota.map((q) => [q.accountId, q]));
    return map;
  }, [quota]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const a of visible) {
      const list = map.get(a.adapterId) ?? [];
      list.push(a);
      map.set(a.adapterId, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

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
    : visible.length === 0
      ? 'Conta CLI'
      : 'Nenhuma ativa';
  const sub = active
    ? `${active.adapterId}${active.onCooldown ? ' · cooldown' : ''}`
    : visible.length > 0
      ? `${visible.length} salva${visible.length === 1 ? '' : 's'}`
      : 'configurar';

  const showRestart =
    restartAdapterId &&
    (!adapterFilter || adapterFilter === restartAdapterId);

  return (
    <div className={`account-switcher ${compact ? 'account-switcher--compact' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="account-switcher__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Hot-swap de conta (Codex, Claude, Grok…) — sem re-login"
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
          {showRestart && (
            <div className="account-switcher__restart">
              <p className="account-switcher__hint">
                Conta trocada para &quot;{restartLabel}&quot;. Sessões abertas
                mantêm a conta antiga.
              </p>
              <button
                type="button"
                className="account-switcher__item account-switcher__item--restart"
                role="menuitem"
                onClick={() => {
                  restartPanesForPendingAccount();
                  setOpen(false);
                }}
              >
                Reiniciar panes {restartAdapterId}
              </button>
              <button
                type="button"
                className="account-switcher__item account-switcher__item--link"
                role="menuitem"
                onClick={() => {
                  clearRestartNotice();
                  setOpen(false);
                }}
              >
                Depois
              </button>
            </div>
          )}
          {visible.length === 0 ? (
            <p className="account-switcher__empty">
              Nenhuma conta salva. Adicione Claude, Codex ou Grok em Config → Providers
              (salvar sessão logada = hot-swap estilo Orca).
            </p>
          ) : (
            grouped.map(([adapterId, list]) => (
              <div key={adapterId} className="account-switcher__group">
                {!adapterFilter && (
                  <p className="account-switcher__group-label">{adapterId}</p>
                )}
                {list.map((a) => {
                  const q = quotaById.get(a.id);
                  const status =
                    q?.status === 'cooldown'
                      ? 'cooldown'
                      : q?.status === 'no-credential'
                        ? 'sem credencial'
                        : a.active
                          ? 'ativa'
                          : 'pronta';
                  return (
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
                          {a.mode === 'subscription' ? 'sub' : a.upstream || 'key'}
                          {a.email ? ` · ${a.email}` : ''}
                          {` · ${status}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
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
