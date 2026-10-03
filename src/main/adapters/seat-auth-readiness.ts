/**
 * Five-state auth readiness for first-wave seating and pre-spawn.
 *
 * Adapted from ORCA's stored-credential state (MIT, `present | incomplete |
 * missing | unreadable | no-credential`): only `present` may launch. A file
 * that *looks* logged-in is not a seat. The other four states remint silently
 * to the next authed adapter. Never toast "Cole sua API key" from autopilot.
 */

export const AUTH_READINESS = [
  'present',
  'incomplete',
  'missing',
  'unreadable',
  'no-credential',
] as const;

/** Canonical five-state contract. First-wave seats only `present`. */
export type AuthReadiness = (typeof AUTH_READINESS)[number];

/** @deprecated Prefer AuthReadiness — kept so existing call sites type-check. */
export type SeatAuthReadiness = AuthReadiness;
export const SEAT_AUTH_READINESS = AUTH_READINESS;

export function isAuthPresent(readiness: AuthReadiness): boolean {
  return readiness === 'present';
}

export function canSeat(readiness: AuthReadiness): boolean {
  return isAuthPresent(readiness);
}

export interface SeatAuthInput {
  readonly adapterId: string;
  readonly authStrategy: string;
  readonly hasKey?: boolean;
  readonly credentialReadiness?: string;
  /**
   * Kimi: classified `kimi provider list` result. Absent means the live list
   * has not been probed — file OAuth alone is incomplete, not a seat.
   */
  readonly kimiListReadiness?: AuthReadiness;
  /** OpenCode free catalog: login-needed may still be present. */
  readonly hasCredentiallessModel?: boolean;
}

const AUTH_ONLY_PRESENT = new Set(['subscription', 'credentialless', 'oauth']);

/**
 * Roster / spawn classifier. Auth-only seats:
 * subscription | credentialless | api-key+hasKey. login-needed = no-credential.
 * LongCat without a key is no-credential. Kimi needs a live oauth source.
 */
export function classifySeatAuth(input: SeatAuthInput): AuthReadiness {
  const adapterId = input.adapterId.trim().toLowerCase();
  const strategy = input.authStrategy.trim().toLowerCase();
  const hasKey = input.hasKey === true;
  if (adapterId === 'qwen' && strategy === 'api-key') {
    const state = input.credentialReadiness;
    if (state === 'invalid-credential' || state === 'no-credential') return 'no-credential';
  }

  if (adapterId === 'kimi') {
    const listed = input.kimiListReadiness;
    if (listed === 'present') return 'present';
    if (hasKey) return 'present';
    return listed ?? 'incomplete';
  }

  if (adapterId === 'longcat' || adapterId === 'deepseek') {
    return hasKey ? 'present' : 'no-credential';
  }

  if (strategy === 'login-needed') {
    return input.hasCredentiallessModel === true ? 'present' : 'no-credential';
  }
  if (AUTH_ONLY_PRESENT.has(strategy)) return 'present';
  if (strategy === 'api-key') return hasKey ? 'present' : 'no-credential';
  return 'no-credential';
}

/** First-wave / auto-seat: AuthReadiness=present only. */
export function firstWaveCanSeat(input: SeatAuthInput): boolean {
  return isAuthPresent(classifySeatAuth(input));
}

export interface ApiKeyToastInput {
  readonly readiness: SeatAuthReadiness;
  readonly explicitCivilianPick: boolean;
}

/**
 * Toast "Cole sua API key" only when a civilian explicitly picked the
 * adapter. Autopilot remint of LongCat / login-needed / missing key is silent.
 */
export function shouldToastApiKeyPaste(input: ApiKeyToastInput): boolean {
  return input.explicitCivilianPick && input.readiness === 'no-credential';
}

const API_KEY_TOAST_RE = /cole\s+sua\s+api\s+key/i;

export function isApiKeyPasteToast(text: string): boolean {
  return API_KEY_TOAST_RE.test(text);
}

/** Hint used on silent remint — never the civilian API-key toast. */
export const SILENT_REMINT_HINT = 'no-credential — remint silencioso';

export function seatFailureHint(input: {
  readonly readiness: SeatAuthReadiness;
  readonly explicitCivilianPick: boolean;
  readonly civilianHint: string;
}): string {
  if (shouldToastApiKeyPaste(input)) return input.civilianHint;
  if (input.readiness === 'no-credential') return SILENT_REMINT_HINT;
  return input.civilianHint;
}

interface KimiProviderRow {
  readonly source?: unknown;
  readonly enabled?: unknown;
  readonly disabled?: unknown;
  readonly status?: unknown;
}

/**
 * Classify `kimi provider list` stdout (JSON or mixed text).
 *
 * - source=oauth (enabled) → present
 * - "No providers configured" without oauth → missing
 * - parse error → unreadable
 * - oauth present but disabled → no-credential
 * - providers without oauth → incomplete
 *
 * A stale "No providers configured" line must not override a live oauth source
 * in the same evidence.
 */
/**
 * ORCA-style file states for the Kimi credentials blob. Usable tokens are
 * `incomplete` here — first-wave `present` still requires `kimi provider list`
 * with source=oauth (the 19 Aug false positive was file-only "logged in").
 */
export function classifyKimiCredentialBlob(
  raw: string | null | undefined,
  ioCode?: string | null,
): AuthReadiness {
  if (ioCode === 'ENOENT' || ioCode === 'ENOTDIR') return 'missing';
  if (ioCode) return 'unreadable';
  if (raw == null) return 'missing';
  const text = raw.trim();
  if (text.length === 0) return 'missing';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'unreadable';
  }
  const rec = parsed as Record<string, unknown>;
  if (Object.keys(rec).length === 0) return 'no-credential';
  const access =
    typeof rec.access_token === 'string' ? rec.access_token.trim() : '';
  const refresh =
    typeof rec.refresh_token === 'string' ? rec.refresh_token.trim() : '';
  if (!access && !refresh) return 'no-credential';
  return 'incomplete';
}

export function classifyKimiProviderList(
  stdout: string | null | undefined,
): AuthReadiness {
  if (stdout == null) return 'unreadable';
  if (typeof stdout !== 'string') return 'unreadable';

  const text = stdout.trim();
  if (text.length === 0) return 'missing';

  const hasNoProvidersMessage = /no providers configured/i.test(text);
  const parsed = tryParseJsonDocument(text);
  if (parsed === undefined) {
    if (hasNoProvidersMessage) return 'missing';
    if (/source\s*=\s*oauth/i.test(text)) return 'present';
    return 'unreadable';
  }

  const rows = collectKimiProviderRows(parsed);
  if (rows === null) {
    return hasNoProvidersMessage ? 'missing' : 'unreadable';
  }

  const oauthEnabled = rows.some(
    (row) => kimiSourceIsOauth(row) && !kimiProviderDisabled(row),
  );
  if (oauthEnabled) return 'present';

  const oauthDisabled = rows.some(
    (row) => kimiSourceIsOauth(row) && kimiProviderDisabled(row),
  );
  if (oauthDisabled) return 'no-credential';

  if (rows.length === 0 || hasNoProvidersMessage) return 'missing';
  return 'incomplete';
}

/**
 * Merge a live classification with a stale cached one. Live oauth (`present`)
 * always wins. A stale "No providers configured" (`missing`) must not
 * downgrade a live oauth source.
 */
export function mergeKimiProviderListReadiness(
  live: SeatAuthReadiness,
  stale?: SeatAuthReadiness | null,
): SeatAuthReadiness {
  // Live oauth (`present`) always wins. Mixed stdout is classified as present
  // before merge, so a stale "No providers configured" cannot downgrade it.
  //
  // `unreadable` não é veredito, é FALHA DE LEITURA (binário lento, timeout de
  // 4 s, auto-update em curso). Deixá-la sobrescrever um `present` quente tira
  // o Kimi do ar para todos os assentos seguintes do processo — inclusive como
  // destino da cadeia de sucessão — que é a mesma troca silenciosa que a sonda
  // ao vivo existe para evitar.
  if (live === 'unreadable' && stale) return stale;
  return live;
}

function tryParseJsonDocument(text: string): unknown | undefined {
  const candidates = [text];
  const firstBrace = text.search(/[{[]/);
  if (firstBrace > 0) candidates.push(text.slice(firstBrace));
  const lastClose = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (firstBrace >= 0 && lastClose > firstBrace) {
    candidates.push(text.slice(firstBrace, lastClose + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next extract
    }
  }
  return undefined;
}

function collectKimiProviderRows(parsed: unknown): KimiProviderRow[] | null {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (row): row is KimiProviderRow =>
        Boolean(row) && typeof row === 'object',
    );
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const nested =
    rec.providers ??
    rec.items ??
    (rec.data && typeof rec.data === 'object'
      ? (rec.data as { providers?: unknown }).providers
      : undefined);
  if (Array.isArray(nested)) {
    return nested.filter(
      (row): row is KimiProviderRow =>
        Boolean(row) && typeof row === 'object',
    );
  }
  // Kimi CLI 0.38 emite `providers` como MAPA (chave = nome do provider),
  // não como array — o operador logava, `kimi provider list` mostrava
  // `source=oauth`, e Providers insistia em "não logado" porque este ramo
  // devolvia vazio (campo 23/08).
  if (nested && typeof nested === 'object') {
    return Object.values(nested as Record<string, unknown>).filter(
      (row): row is KimiProviderRow =>
        Boolean(row) && typeof row === 'object',
    );
  }
  if (kimiLooksLikeProviderRow(rec)) return [rec];
  return [];
}

function kimiLooksLikeProviderRow(row: Record<string, unknown>): boolean {
  return (
    'source' in row ||
    'oauth' in row ||
    'baseUrl' in row ||
    'enabled' in row ||
    'disabled' in row ||
    'status' in row
  );
}

function kimiSourceIsOauth(row: KimiProviderRow): boolean {
  if (
    typeof row.source === 'string' &&
    row.source.trim().toLowerCase() === 'oauth'
  ) {
    return true;
  }
  // 0.38 não tem campo `source` no JSON: o assento OAuth aparece como objeto
  // aninhado — `"oauth": { "storage": "file", "key": "oauth/kimi-code" }`.
  // Objeto vazio não é assento.
  const oauth = (row as { oauth?: unknown }).oauth;
  return (
    Boolean(oauth) &&
    typeof oauth === 'object' &&
    !Array.isArray(oauth) &&
    Object.keys(oauth as Record<string, unknown>).length > 0
  );
}

function kimiProviderDisabled(row: KimiProviderRow): boolean {
  if (row.disabled === true) return true;
  if (row.enabled === false) return true;
  if (typeof row.status === 'string') {
    const status = row.status.trim().toLowerCase();
    return status === 'disabled' || status === 'inactive';
  }
  return false;
}

let kimiReadinessCache: SeatAuthReadiness | undefined;

/** Last warmed `kimi provider list` classification (process-lifetime). */
export function peekKimiSeatReadiness(): SeatAuthReadiness | undefined {
  return kimiReadinessCache;
}

export function rememberKimiSeatReadiness(
  readiness: SeatAuthReadiness | undefined,
): void {
  kimiReadinessCache = readiness;
}

/**
 * Production roster gate. When Kimi's live list has been probed, only
 * `present` (or api-key+hasKey) seats. Other adapters follow auth-only.
 */
export function canSeatFromProvider(provider: {
  readonly adapterId: string;
  readonly authStrategy: string;
  readonly hasKey?: boolean;
  readonly credentialReadiness?: string;
}): boolean {
  const listed =
    provider.adapterId === 'kimi' ? peekKimiSeatReadiness() : undefined;
  return canSeat(
    classifySeatAuth({
      adapterId: provider.adapterId,
      authStrategy: provider.authStrategy,
      hasKey: provider.hasKey,
      credentialReadiness: provider.credentialReadiness,
      kimiListReadiness: listed,
    }),
  );
}
