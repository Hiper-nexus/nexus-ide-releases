import { z } from 'zod';
import type { QuotaWindow } from '../../shared/quota-types';
import type { LiveProviderProbe } from './provider-live-usage';

export const MIMO_CONSOLE_ORIGIN = 'https://platform.xiaomimimo.com';
const PLAN_ENDPOINTS = new Set(['cn', 'sgp', 'ams'].map(region => `https://token-plan-${region}.xiaomimimo.com/v1`));
const MAX_RESPONSE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const envelope = z.object({ code: z.union([z.literal(0), z.literal(200)]), data: z.unknown() });
const identity = z.object({ userId: z.union([z.string().min(1).max(128), z.number().int().nonnegative().safe()]) });
const usageSchema = z.object({ usage: z.object({ items: z.array(z.object({
  name: z.string().min(1).max(80).regex(/^[\w .-]+$/),
  used: z.number().finite().nonnegative(), limit: z.number().finite().nonnegative(),
  percent: z.number().finite().min(0).max(1),
})).min(1).max(20) }) });
export interface MimoQuotaIdentity { uid?: string; baseUrl: string }
export type MimoConsoleFetch = (url: string, init: RequestInit) => Promise<Response>;
export function isMimoTokenPlan(auth: MimoQuotaIdentity | null): boolean {
  return !!auth?.uid && PLAN_ENDPOINTS.has(auth.baseUrl);
}
function dataOf(raw: unknown): unknown {
  const parsed = envelope.safeParse(raw);
  return parsed.success ? parsed.data.data : null;
}
export function parseMimoTokenPlanUsage(raw: unknown): QuotaWindow[] | null {
  const parsed = usageSchema.safeParse(dataOf(raw));
  if (!parsed.success) return null;
  const items = parsed.data.usage.items.filter(item => item.name !== 'compensation_total_token' || item.limit !== 0);
  if (!items.length || items.some(item => item.limit <= 0)) return null;
  return items.map(item => ({
    kind: 'credits', label: item.name === 'total_token' ? 'Token Plan' : item.name === 'compensation_total_token' ? 'Créditos de compensação' : `Token Plan · ${item.name}`, usedRatio: item.percent,
    source: 'provider-api', confidence: 'high',
    remainingLabel: `${Math.max(0, item.limit - item.used).toLocaleString('pt-BR')} de ${item.limit.toLocaleString('pt-BR')} créditos disponíveis`,
  }));
}
async function readConsole(fetchImpl: MimoConsoleFetch, endpoint: '/userProfile' | '/tokenPlan/usage'): Promise<unknown> {
  const response = await fetchImpl(`${MIMO_CONSOLE_ORIGIN}/api/v1${endpoint}`, {
    method: 'GET', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}
async function sameAccount(fetchImpl: MimoConsoleFetch, uid: string): Promise<boolean> {
  const parsed = identity.safeParse(dataOf(await readConsole(fetchImpl, '/userProfile')));
  return parsed.success && String(parsed.data.userId) === uid;
}
/** Public console JS maps userProfile.userId directly to CLI metadata.uid.
 * Its currentPeriodEnd is subscription expiry, so no reset is inferred here. */
export async function probeMimoTokenPlan(auth: MimoQuotaIdentity | null, fetchImpl: MimoConsoleFetch): Promise<LiveProviderProbe> {
  if (!auth) return { windows: null, hint: 'no-credential' };
  if (!isMimoTokenPlan(auth)) return { windows: null, hint: 'unavailable' };
  try {
    if (!await sameAccount(fetchImpl, auth!.uid!)) return { windows: null, hint: 'unavailable' };
    const windows = parseMimoTokenPlanUsage(await readConsole(fetchImpl, '/tokenPlan/usage'));
    if (!await sameAccount(fetchImpl, auth!.uid!)) return { windows: null, hint: 'unavailable' };
    return windows ? { windows } : { windows: null, hint: 'unavailable' };
  } catch { return { windows: null, hint: 'unavailable' }; }
}
