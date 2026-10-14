/**
 * Frescor de credencial de provider — puro, sem I/O, sem Electron.
 *
 * Todo adapter file-backed guarda a sessão num JSON com formato próprio. O
 * motor precisa responder UMA pergunta: entre dois blobs DO MESMO adapter
 * (o snapshot do vault e o arquivo que a CLI reescreveu), qual nasceu depois?
 *
 * A versão anterior desta lógica só conhecia o formato do Codex
 * (`last_refresh` no topo, ou `tokens.access_token`). Para Grok, OpenCode,
 * Kimi e AGY ela devolvia `null` SEMPRE, e as duas consequências eram graves:
 *
 *  - `shouldWriteAuthFile` caía no ramo "formato desconhecido: não sobrescreve"
 *    e o managed home ficava preso num token morto para sempre;
 *  - `readBackFresherAuth` caía no ramo "ambos nulos: prefere o disco" e
 *    PROMOVIA o token morto para dentro do vault.
 *
 * Resultado de campo: login novo feito pelo usuário, conta salva continuava
 * apontando para uma credencial vencida havia semanas.
 *
 * Em vez de enumerar formato por formato (que quebra na próxima CLI), o
 * scanner varre o blob em profundidade e colhe TODO sinal temporal crível,
 * inclusive dentro de JWTs embutidos (o Grok guarda a sessão em
 * `{"<issuer>::<uuid>": {"key": "<jwt>"}}`) e dentro de snapshots de diretório
 * (`__nexusDirSnapshot`, usado por Kimi/AGY), onde os valores são strings que
 * contêm outro JSON.
 */

/** Dois tiers: quando nasceu (emissão) e até quando vale (expiração). */
export interface AuthFreshness {
  /** Epoch ms do sinal de EMISSÃO mais recente (login/refresh), ou null. */
  readonly issuedAt: number | null;
  /** Epoch ms do sinal de EXPIRAÇÃO mais distante, ou null. */
  readonly expiresAt: number | null;
}

/**
 * Janela de sanidade. Fora dela o número não é data de credencial — é
 * contador, versão de schema ou lixo. Aceitar `0`/`1` como "1970" faria um
 * blob sem data vencer a comparação contra um blob com data real.
 */
const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

/** Guardas de custo: um blob hostil não pode virar varredura sem fim. */
const MAX_DEPTH = 12;
const MAX_NODES = 5_000;
const MAX_ARRAY_ITEMS = 64;

function normalizedKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

/**
 * Quando a credencial foi emitida/renovada. É o sinal PREFERIDO: cresce
 * monotonicamente a cada login ou refresh, independente do TTL do provider.
 */
const ISSUED_KEYS: ReadonlySet<string> = new Set([
  'lastrefresh',
  'refreshedat',
  'refreshtime',
  'lastrefreshed',
  'createtime',
  'createdat',
  'creationtime',
  'issuedat',
  'obtainedat',
  'authtime',
  'lastlogin',
  'lastauthenticated',
  'updatedat',
  'lastupdated',
  'iat',
]);

/**
 * Até quando a credencial vale. Só desempata quando NENHUM dos lados tem
 * sinal de emissão: um token de TTL curto emitido hoje expira antes de um
 * token de TTL longo emitido mês passado, então expiração sozinha não é
 * prova de recência.
 *
 * `expires_in` fica deliberadamente de fora: é duração relativa, não instante.
 */
const EXPIRY_KEYS: ReadonlySet<string> = new Set([
  'expiresat',
  'expires',
  'expiry',
  'expirydate',
  'expiretime',
  'expirytime',
  'expiration',
  'expirationtime',
  'accesstokenexpiresat',
  'refreshtokenexpiresat',
  'exp',
]);

/**
 * Converte um valor bruto em epoch ms, ou null.
 *
 * Providers desta frota gravam o mesmo instante em quatro unidades
 * diferentes: ISO-8601 (Grok `create_time`), segundos (JWT `exp`),
 * milissegundos (OpenCode `expires`) e microssegundos (algumas builds).
 * A magnitude desambigua, e a janela de sanidade descarta o resto.
 */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return plausible(fromMagnitude(value));
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return plausible(fromMagnitude(Number(trimmed)));
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? plausible(parsed) : null;
}

function fromMagnitude(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e15) return n / 1000; // microssegundos
  if (n >= 1e12) return n; // milissegundos
  if (n >= 1e9) return n * 1000; // segundos
  return null; // pequeno demais para ser instante: contador, não data
}

function plausible(ms: number | null): number | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null;
}

/** Payload de um JWT compacto, sem verificar assinatura (só leitura de claim). */
function decodeJwtClaims(value: string): Record<string, unknown> | null {
  // Barato antes de caro: só strings com cara de JWT pagam o base64.
  if (!value.startsWith('eyJ')) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed: unknown = JSON.parse(
      Buffer.from(padded, 'base64').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** JSON aninhado como string (valores de `__nexusDirSnapshot.files`). */
function decodeNestedJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

interface ScanState {
  issuedAt: number | null;
  expiresAt: number | null;
  nodes: number;
}

function record(state: ScanState, key: string, value: unknown): void {
  const normalized = normalizedKey(key);
  const isIssued = ISSUED_KEYS.has(normalized);
  const isExpiry = !isIssued && EXPIRY_KEYS.has(normalized);
  if (!isIssued && !isExpiry) return;
  const ms = toEpochMs(value);
  if (ms === null) return;
  if (isIssued) {
    state.issuedAt = state.issuedAt === null ? ms : Math.max(state.issuedAt, ms);
    return;
  }
  state.expiresAt =
    state.expiresAt === null ? ms : Math.max(state.expiresAt, ms);
}

function scan(value: unknown, state: ScanState, depth: number): void {
  if (depth > MAX_DEPTH || state.nodes >= MAX_NODES) return;
  state.nodes += 1;

  if (typeof value === 'string') {
    const claims = decodeJwtClaims(value);
    if (claims) {
      scan(claims, state, depth + 1);
      return;
    }
    const nested = decodeNestedJson(value);
    if (nested !== null) scan(nested, state, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      scan(item, state, depth + 1);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    record(state, key, child);
    scan(child, state, depth + 1);
  }
}

/**
 * Sinais de frescor de um blob de auth. `null` quando o conteúdo não é JSON
 * ou não carrega nenhum instante crível (ex.: TOML do Devin, auth do Muse que
 * delega o token ao Keychain). Nunca lança.
 */
export function authBlobFreshness(contents: string): AuthFreshness | null {
  if (typeof contents !== 'string' || contents.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  const state: ScanState = { issuedAt: null, expiresAt: null, nodes: 0 };
  scan(parsed, state, 0);
  if (state.issuedAt === null && state.expiresAt === null) return null;
  return { issuedAt: state.issuedAt, expiresAt: state.expiresAt };
}

/**
 * Ordena dois blobs por recência: `1` se `left` é mais novo, `-1` se `right`
 * é, `0` se empatam, e **`null` quando não são comparáveis** — e aí quem
 * chama decide a política, em vez de receber um falso empate.
 *
 * Compara emissão contra emissão, ou expiração contra expiração. Nunca mistura
 * os tiers: um blob que só tem `exp` e outro que só tem `iat` são
 * incomparáveis, não iguais.
 */
export function compareAuthFreshness(
  left: string,
  right: string,
): -1 | 0 | 1 | null {
  const a = authBlobFreshness(left);
  const b = authBlobFreshness(right);
  if (!a || !b) return null;
  if (a.issuedAt !== null && b.issuedAt !== null) {
    return sign(a.issuedAt - b.issuedAt);
  }
  if (a.expiresAt !== null && b.expiresAt !== null) {
    return sign(a.expiresAt - b.expiresAt);
  }
  return null;
}

/**
 * F-1485: o Grok só renova a sessão até 7 dias depois da última emissão — a
 * própria CLI (1.0.52) documenta "tokens expire after 7 days; Grok will prompt
 * you to re-authenticate". O access token vale 6 h; a emissão é o maior
 * `create_time`/`iat` do blob, que cada renovação avança.
 */
export const GROK_SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Sessão Grok que a CLI não consegue mais renovar: acesso vencido e última
 * emissão além da janela. Sem data de emissão legível não há prova — false.
 */
export function grokSessionNeedsLogin(contents: string, now = Date.now()): boolean {
  const freshness = authBlobFreshness(contents);
  if (!freshness || freshness.issuedAt === null) return false;
  if (freshness.expiresAt !== null && freshness.expiresAt > now) return false;
  return now - freshness.issuedAt > GROK_SESSION_REFRESH_WINDOW_MS;
}

function sign(delta: number): -1 | 0 | 1 {
  if (delta > 0) return 1;
  if (delta < 0) return -1;
  return 0;
}
