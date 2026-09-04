import type { AccountQuotaInfo } from '../../shared/account-types';
import { listAccountInfos } from './account-store';

/**
 * Lightweight quota view for the status bar (P4).
 * Full ChatGPT/Claude network rate-limit fetch (Orca) is deferred; we surface
 * cooldown, last limit reason, and credential readiness from the account store
 * so the switcher can show "ready / cooling down" without secret material.
 */
export function listAccountQuota(): AccountQuotaInfo[] {
  return listAccountInfos().map((a) => {
    let status: AccountQuotaInfo['status'] = 'inactive';
    // Refresh morto = spawn recusado no prepare: oferecer como 'ready' no
    // switcher queimaria uma sessão num 401 garantido.
    if (!a.hasCredential || a.needsRelogin) status = 'no-credential';
    else if (a.onCooldown) status = 'cooldown';
    else if (a.active) status = 'ready';
    else status = 'inactive';
    return {
      accountId: a.id,
      adapterId: a.adapterId,
      label: a.label,
      active: a.active,
      onCooldown: a.onCooldown,
      cooldownUntil: a.cooldownUntil,
      lastError: a.lastError,
      email: a.email,
      mode: a.mode,
      hasCredential: a.hasCredential,
      status,
    };
  });
}
