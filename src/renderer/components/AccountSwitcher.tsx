import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAccountStore } from '../state/account-store';
import { useSettingsStore } from '../state/settings-store';
import { useQuotaStore, entryForAccount } from '../state/quota-store';
import { shortWindowsLine } from '../lib/quota-display';
import {
  restartPanesForPendingAccount,
} from '../orch/account-restart-controller';
import { PixelIcon } from './PixelIcon';
import { ActionCard } from './ActionCard';

/**
 * Compact multi-account control (hot-swap chip).
 * Groups by adapter, activates a saved account, surfaces quota/cooldown,
 * and offers restart of live panes after a switch.
 * Menu supports arrow-key roving focus (↑/↓/Home/End) + Escape.
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
  const fleetQuota = useQuotaStore((s) => s.snapshot);
  const activate = useAccountStore((s) => s.activate);
  const restartAdapterId = useAccountStore((s) => s.restartAdapterId);
  const restartLabel = useAccountStore((s) => s.restartLabel);
  const clearRestartNotice = useAccountStore((s) => s.clearRestartNotice);
  const openDrawer = useSettingsStore((s) => s.openDrawer);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  const closeMenu = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const menuItems = useCallback((): HTMLButtonElement[] => {
    if (!menuRef.current) return [];
    return [
      ...menuRef.current.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([disabled])',
      ),
    ];
  }, []);

  const focusMenuIndex = useCallback(
    (index: number) => {
      const items = menuItems();
      if (items.length === 0) return;
      const next = ((index % items.length) + items.length) % items.length;
      items[next]?.focus();
    },
    [menuItems],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeMenu(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, closeMenu]);

  // Focus first actionable item when the menu opens (layout phase so tests
  // and real paint both see a focused menuitem without waiting for rAF).
  useLayoutEffect(() => {
    if (!open) return;
    focusMenuIndex(0);
  }, [open, focusMenuIndex, visible.length, restartAdapterId]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (items.length === 0) return;

    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusMenuIndex(current < 0 ? 0 : current + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusMenuIndex(current < 0 ? items.length - 1 : current - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusMenuIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusMenuIndex(items.length - 1);
    } else if (e.key === 'Tab') {
      // Leave the menu on Tab; keep natural tab order outside.
      closeMenu(false);
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      if (!open) {
        e.preventDefault();
        setOpen(true);
      }
    }
  };

  // Empty vault ≠ CLI not logged in. Native OS login still runs panes;
  // vault accounts are what multi-account failover/hot-swap needs.
  const label = active
    ? active.label
    : visible.length === 0
      ? 'Nativa'
      : 'Nenhuma ativa';
  const sub = active
    ? `${active.adapterId}${active.onCooldown ? ' · cooldown' : ''}`
    : visible.length > 0
      ? `${visible.length} vault`
      : 'sem vault';

  const showRestart =
    restartAdapterId &&
    (!adapterFilter || adapterFilter === restartAdapterId);

  const triggerState = active
    ? active.onCooldown
      ? 'cool'
      : 'on'
    : visible.length > 0
      ? 'idle'
      : 'off';

  return (
    <div className={`account-switcher ${compact ? 'account-switcher--compact' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="account-switcher__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'account-switcher-menu' : undefined}
        aria-label={`Conta CLI: ${label}. ${sub}`}
        title={
          visible.length === 0
            ? 'CLI pode estar logado no sistema (sessão nativa). O vault multi-conta ainda está vazio — salve uma sessão ou API key para failover.'
            : 'Hot-swap de conta (Codex, Claude, Grok…) — contas salvas no vault do Nexus'
        }
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="account-switcher__dot" data-state={triggerState} />
        <span className="account-switcher__text">
          <span className="account-switcher__label">{label}</span>
          {!compact && <span className="account-switcher__sub">{sub}</span>}
        </span>
        <span className="account-switcher__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          id="account-switcher-menu"
          ref={menuRef}
          className="account-switcher__menu"
          role="menu"
          aria-label="Contas CLI"
          onKeyDown={onMenuKeyDown}
        >
          {showRestart && (
            <div className="account-switcher__restart">
              <p className="account-switcher__hint">
                Conta trocada para &quot;{restartLabel}&quot;. Sessões abertas
                mantêm a conta antiga até reiniciar.
              </p>
              <button
                type="button"
                className="account-switcher__item account-switcher__item--restart"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  restartPanesForPendingAccount();
                  closeMenu(true);
                }}
              >
                <PixelIcon name="restart" size={12} />
                <span>Reiniciar panes {restartAdapterId}</span>
              </button>
              <button
                type="button"
                className="account-switcher__item account-switcher__item--link"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  clearRestartNotice();
                  closeMenu(true);
                }}
              >
                Depois
              </button>
            </div>
          )}
          {visible.length === 0 ? (
            <div
              className="account-switcher__empty-panel"
              role="status"
            >
              <p className="account-switcher__empty-title">
                Vault multi-conta vazio
              </p>
              <p className="account-switcher__empty-body">
                CLI logado no sistema <strong>≠</strong> conta no vault. Os
                panes usam a sessão nativa; o vault serve para trocar de conta
                e failover.
              </p>
              <p className="account-switcher__empty-step">
                Providers → CLI → <strong>Salvar sessão logada</strong>
              </p>
              <ActionCard
                icon="key"
                title="Abrir Providers"
                subtitle="salvar sessão · API key"
                variant="primary"
                size="sm"
                className="account-switcher__empty-cta"
                onClick={() => {
                  setOpen(false);
                  openDrawer('providers');
                }}
              />
            </div>
          ) : (
            grouped.map(([adapterId, list]) => (
              <div key={adapterId} className="account-switcher__group" role="group" aria-label={adapterId}>
                {!adapterFilter && (
                  <p className="account-switcher__group-label" id={`acct-group-${adapterId}`}>
                    {adapterId}
                  </p>
                )}
                {list.map((a) => {
                  const q = quotaById.get(a.id);
                  const state = a.onCooldown
                    ? 'cool'
                    : !a.hasCredential || q?.status === 'no-credential'
                      ? 'warn'
                      : a.active
                        ? 'on'
                        : 'ready';
                  const status =
                    q?.status === 'cooldown' || a.onCooldown
                      ? 'cooldown'
                      : q?.status === 'no-credential' || !a.hasCredential
                        ? 'sem credencial'
                        : a.active
                          ? 'ativa'
                          : 'pronta';
                  const kind =
                    a.mode === 'subscription' ? 'sub' : a.upstream || 'key';
                  const disabled = busy || a.onCooldown || !a.hasCredential;
                  const fleetEntry = entryForAccount(
                    fleetQuota,
                    a.adapterId,
                    a.id,
                  );
                  const windowsLine = fleetEntry
                    ? shortWindowsLine(fleetEntry)
                    : 'cota · —';
                  return (
                    <button
                      key={a.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className={`account-switcher__item ${a.active ? 'account-switcher__item--active' : ''}`}
                      disabled={disabled}
                      aria-current={a.active ? 'true' : undefined}
                      title={
                        a.onCooldown
                          ? `Em cooldown${a.lastError ? `: ${a.lastError}` : ''}`
                          : !a.hasCredential
                            ? 'Sem credencial salva'
                            : `Ativar ${a.label} · ${windowsLine}`
                      }
                      onClick={() => {
                        setBusy(true);
                        setNote(null);
                        void activate(a.id)
                          .then((r) => {
                            if (!r.ok) setNote(r.error ?? 'Falha ao ativar');
                            else closeMenu(true);
                          })
                          .catch((err) => {
                            setNote(
                              err instanceof Error ? err.message : 'Falha ao ativar',
                            );
                          })
                          .finally(() => setBusy(false));
                      }}
                    >
                      <span
                        className="account-switcher__item-dot"
                        data-state={state}
                        aria-hidden="true"
                      />
                      <span className="account-switcher__item-main">
                        <span className="account-switcher__item-label">
                          {a.label}
                          {a.active && (
                            <span className="account-switcher__item-pill">em uso</span>
                          )}
                        </span>
                        <span className="account-switcher__item-meta">
                          {kind}
                          {a.email ? ` · ${a.email}` : ''}
                          {` · ${status}`}
                        </span>
                        <span className="account-switcher__quota">
                          {windowsLine}
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
          {note && <p className="account-switcher__err" role="alert">{note}</p>}
          <button
            type="button"
            className="account-switcher__item account-switcher__item--link"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              closeMenu(false);
              openDrawer('providers');
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
