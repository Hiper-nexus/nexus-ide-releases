/** A single MAC-protected vault record binds the current session and every
 * account's clock/emission history. The durable MAC key stays in the OS-backed
 * vault across logout; deleting either entry requires online revalidation.
 * Permission queries only read already-unlocked secrets.
 */
import crypto from 'node:crypto';
export const LICENSE_SEAL_KEY = 'auth:license-seal-key';
export type LicenseAccountStore = Pick<typeof import('./persistence/secrets-store'), 'getSecret' | 'setInternalSecret' | 'hasCachedSecret'>;
export interface LicenseSeal {
  clockFloor: number;
  latestIat: number | null;
  revokedAt: number | null;
  needsOnlineValidation: boolean;
}
interface AccountState {
  version: 2;
  binding: { id: string; sessionHash: string } | null;
  accounts: Record<string, LicenseSeal>;
}
export interface LicenseAccountState {
  id: string;
  sessionHash: string;
  seal: LicenseSeal;
}
export function isLicenseSeal(value: unknown): value is LicenseSeal {
  if (!value || typeof value !== 'object') return false;
  const s = value as LicenseSeal;
  const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return typeof s.clockFloor === 'number' && Number.isFinite(s.clockFloor) && s.clockFloor > 0 &&
    typeof s.needsOnlineValidation === 'boolean' &&
    (s.latestIat === null ? s.needsOnlineValidation : (timestamp(s.latestIat) && s.clockFloor >= s.latestIat * 1000)) &&
    (s.revokedAt === null || (timestamp(s.revokedAt) && s.latestIat !== null && s.revokedAt <= s.latestIat));
}
function cachedKey(store: LicenseAccountStore): string | null {
  if (!store.hasCachedSecret(LICENSE_SEAL_KEY)) return null;
  const key = store.getSecret(LICENSE_SEAL_KEY);
  return key && /^[a-f0-9]{64}$/.test(key) ? key : null;
}
function signature(state: AccountState, rootKey: string): Buffer {
  const binding = state.binding ? `${state.binding.id}\0${state.binding.sessionHash}` : 'signed-out';
  const key = crypto.createHmac('sha256', Buffer.from(rootKey, 'hex')).update(`nexus-license-account-state-v2\0${binding}`).digest();
  return crypto.createHmac('sha256', key).update(JSON.stringify(state)).digest();
}
function readState(store: LicenseAccountStore): AccountState | null {
  if (!store.hasCachedSecret('auth:account')) return null;
  const key = cachedKey(store);
  if (!key) return null;
  try {
    const envelope = JSON.parse(store.getSecret('auth:account')!);
    const state = envelope.state as AccountState;
    if (!state || state.version !== 2 || !state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts) ||
      !Object.values(state.accounts).every(isLicenseSeal) ||
      (state.binding !== null && (!state.binding || typeof state.binding.id !== 'string' || !state.binding.id.trim() ||
        !/^[a-f0-9]{64}$/.test(state.binding.sessionHash) || !Object.hasOwn(state.accounts, state.binding.id))) ||
      typeof envelope.mac !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.mac)) return null;
    return crypto.timingSafeEqual(Buffer.from(envelope.mac, 'hex'), signature(state, key)) ? state : null;
  } catch { return null; }
}
function writeState(store: LicenseAccountStore, state: AccountState): { ok: boolean; error?: string } {
  const key = cachedKey(store);
  if (!key) return { ok: false };
  return store.setInternalSecret('auth:account', JSON.stringify({ state, mac: signature(state, key).toString('hex') }));
}
export function readLicenseAccountState(store: LicenseAccountStore, previousSession?: string): LicenseAccountState | null {
  if (!previousSession && !store.hasCachedSecret('auth:session')) return null;
  const state = readState(store);
  const session = previousSession ?? store.getSecret('auth:session');
  if (!state?.binding || !session || state.binding.sessionHash !== crypto.createHash('sha256').update(session).digest('hex')) return null;
  return { ...state.binding, seal: state.accounts[state.binding.id] };
}
/** Only authenticated exchange/refresh or /me may establish a binding. */
export function bindLicenseAccount(id: string, session: string, store: LicenseAccountStore, previousSession?: string): { ok: boolean; error?: string } {
  store.getSecret(LICENSE_SEAL_KEY);
  store.getSecret('auth:account');
  if (!cachedKey(store)) {
    const created = store.setInternalSecret(LICENSE_SEAL_KEY, crypto.randomBytes(32).toString('hex'));
    if (!created.ok) return { ok: false };
  }
  const previous = readState(store);
  if (previousSession && previous?.binding && previous.binding.sessionHash !== crypto.createHash('sha256').update(previousSession).digest('hex')) return { ok: false };
  const history = previous && Object.hasOwn(previous.accounts, id) ? previous.accounts[id] : null;
  const seal: LicenseSeal = { clockFloor: Math.max(Date.now(), history?.clockFloor ?? 0),
    latestIat: history?.latestIat ?? null, revokedAt: history?.revokedAt ?? null, needsOnlineValidation: true };
  return writeState(store, { version: 2, binding: { id, sessionHash: crypto.createHash('sha256').update(session).digest('hex') },
    accounts: { ...previous?.accounts, [id]: seal } });
}
export function persistLicenseSeal(store: LicenseAccountStore, seal: LicenseSeal): { ok: boolean; error?: string } {
  const state = readState(store);
  const bound = readLicenseAccountState(store);
  if (!state || !bound || !isLicenseSeal(seal)) return { ok: false };
  return writeState(store, { ...state, accounts: { ...state.accounts, [bound.id]: seal } });
}
/** Logout removes the binding, never the account's anti-replay history. */
export function invalidateLicenseAccountBinding(store: LicenseAccountStore): { ok: boolean; error?: string } {
  const state = readState(store);
  return state ? writeState(store, { ...state, binding: null }) : { ok: true };
}
