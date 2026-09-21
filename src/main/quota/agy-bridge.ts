/**
 * Bridge local do Antigravity — port do `AntigravityBridge` +
 * `AntigravityQuotaParser` do Codenotch.
 *
 * O Google recusa a sonda direta: `retrieveUserQuota*` no cloudcode-pa
 * responde 403 "no valid license" para conta pessoal, porque a API julga
 * QUEM pede — e o Nexus não pode assinar como Antigravity. A própria janela
 * do IDE resolve igual: pergunta ao language server local, que já detém a
 * credencial e a identidade de cliente, e deixa ele chamar o Google.
 *
 * Como achar (a porta nunca é escrita em arquivo — a tabela de processos é
 * a fonte):
 *  - `ps`: `language_server` com `--csrf_token <tok>` (IDE), ou o binário
 *    `agy` (CLI — serve o mesmo RPC para qualquer um no loopback).
 *  - `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN`: portas reais do processo.
 *  - POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/
 *    RetrieveUserQuotaSummary  body {"forceRefresh":true}
 *    header `x-codeium-csrf-token` (o servidor reclama "missing CSRF token",
 *    nunca qual header queria — descoberta do Codenotch lendo o binário).
 *  - Cert self-signed: TLS sem verificação SÓ no loopback do próprio LS.
 *
 * `forceRefresh` é o que faz a leitura ser viva: o LS mantém
 * `QuotaSummaryCache` e um request vazio seria servido do cache.
 *
 * A resposta reporta o que SOBRA (`remainingFraction`), não o que foi usado
 * — o invert é aqui. Sem o processo rodando, null honesto (o OAuth direto
 * segue como caminho seguinte da cascata).
 */

import { spawnSync } from 'node:child_process';
import https from 'node:https';
import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';

const AGY_BRIDGE_SERVICE =
  '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const AGY_CSRF_HEADER = 'x-codeium-csrf-token';
const AGY_BRIDGE_TIMEOUT_MS = 10_000;

export interface AgyBridgeEndpoint {
  /** Toda porta que o LS escuta — ele abre duas e só uma serve este RPC. */
  ports: number[];
  /** Token do IDE; o `agy` CLI não pede (loopback serve a qualquer um). */
  csrfToken: string | null;
}

function run(cmd: string, args: string[], timeoutMs = 5_000): string {
  try {
    const res = spawnSync(cmd, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    });
    return res.stdout?.toString('utf8') ?? '';
  } catch {
    return '';
  }
}

function flagValue(flag: string, line: string): string | null {
  const parts = line.split(' ');
  const at = parts.indexOf(flag);
  return at >= 0 && at + 1 < parts.length ? parts[at + 1]! : null;
}

/** O `agy` CLI roda como `agy` puro — casa pelo nome do executável, não por
 * substring ("agy" aparece dentro de palavras e paths de verdade). */
function isAgyCli(line: string): boolean {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 2) return false;
  const bin = fields[1]!.split('/').pop();
  return bin === 'agy';
}

export function listeningPortsOfPid(pid: number): number[] {
  // `-a` é load-bearing: sem ele o lsof faz OR dos filtros e devolve todo
  // socket LISTEN da máquina (o bridge discaria a porta de outro processo).
  const out = run('/usr/sbin/lsof', [
    '-nP',
    '-a',
    '-p',
    String(pid),
    '-iTCP',
    '-sTCP:LISTEN',
  ]);
  const ports: number[] = [];
  for (const line of out.split('\n')) {
    const addr = line
      .split(' ')
      .filter(Boolean)
      .find((field) => field.includes(':'));
    if (!addr) continue;
    const port = Number(addr.split(':').pop());
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
  }
  return ports;
}

function endpointForLine(
  line: string,
  token: string | null,
  portsOfPid: (pid: number) => number[],
): AgyBridgeEndpoint | null {
  const pid = Number(line.trim().split(/\s+/)[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ports = portsOfPid(pid);
  if (ports.length === 0) return null;
  return { ports, csrfToken: token };
}

/**
 * Descobre o endpoint do language server: primeiro o do IDE (com CSRF), se
 * não o `agy` CLI (sem token). null quando nenhum dos dois está rodando —
 * Antigravity fechado é o caso comum, não uma falha.
 */
export function discoverAgyBridge(
  opts: {
    processTable?: string;
    portsOfPid?: (pid: number) => number[];
  } = {},
): AgyBridgeEndpoint | null {
  const table = opts.processTable ?? run('/bin/ps', ['-Ao', 'pid,command']);
  const portsOfPid = opts.portsOfPid ?? listeningPortsOfPid;
  const lines = table.split('\n');

  // Codenotch casa qualquer `language_server` com csrf — suficiente no app
  // dele, mas aqui Windsurf/Devin rodam o MESMO protocolo Codeium; um LS
  // Windsurf devolveria quota Windsurf na linha AGY. Só vale processo cuja
  // linha de comando aponte para o Antigravity.
  const ide = lines.find(
    (line) =>
      line.includes('language_server') &&
      line.includes('--csrf_token') &&
      line.toLowerCase().includes('antigravity'),
  );
  if (ide) {
    const token = flagValue('--csrf_token', ide);
    const endpoint = token ? endpointForLine(ide, token, portsOfPid) : null;
    if (endpoint) return endpoint;
  }

  const cli = lines.find(isAgyCli);
  if (cli) return endpointForLine(cli, null, portsOfPid);
  return null;
}

// ---------------------------------------------------------------------------
// Parser — envelopes do LS e do Cloud Code compartilham o mesmo normalizador
// (ports do AntigravityQuotaParser): `groups` vencem `buckets`; o número do
// wire é "restante", o nosso é "usado".
// ---------------------------------------------------------------------------

interface AgyBucket {
  modelId?: string;
  bucketId?: string;
  name?: string;
  displayName?: string;
  remainingFraction?: number;
  remaining?: { remainingFraction?: number; case?: string; value?: number };
  used?: number;
  limit?: number;
  resetTime?: string;
  window?: string;
  disabled?: boolean;
}

interface AgyGroup {
  displayName?: string;
  buckets?: AgyBucket[];
}

function bucketFraction(b: AgyBucket): number | null {
  if (typeof b.remainingFraction === 'number') return b.remainingFraction;
  const r = b.remaining;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.remainingFraction === 'number') return r.remainingFraction;
  if (r.case === 'remainingFraction' && typeof r.value === 'number') {
    return r.value;
  }
  return null;
}

function bucketId(b: AgyBucket, group?: string): string {
  for (const v of [b.bucketId, b.modelId, b.name, group]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'quota';
}

function parseResetMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

type Cadence = 'session' | 'weekly' | 'unknown';

function norm(v: string): string {
  return v.trim().toLowerCase().replace(/_/g, '-');
}

function cadenceValue(raw?: string): string | null {
  if (!raw) return null;
  const v = norm(raw);
  if (!v) return null;
  return v.endsWith(' limit') ? v.slice(0, -' limit'.length) : v;
}

function isWeeklyValue(v: string): boolean {
  return v === 'weekly' || v.endsWith('-weekly') || v.endsWith(' weekly');
}

function isSessionValue(v: string): boolean {
  return (
    v === 'session' ||
    v === '5h' ||
    v === '5-hour' ||
    v === 'five hour' ||
    v === 'five-hour' ||
    v === 'hourly' ||
    v.endsWith('-session') ||
    v.endsWith('-5h') ||
    v.endsWith('-5-hour') ||
    v.endsWith('-five-hour') ||
    v.endsWith('-hourly')
  );
}

function cadenceOf(b: AgyBucket): Cadence {
  for (const field of [b.window, b.bucketId, b.displayName]) {
    const v = cadenceValue(field);
    if (v && isWeeklyValue(v)) return 'weekly';
  }
  for (const field of [b.window, b.bucketId, b.displayName]) {
    const v = cadenceValue(field);
    if (v && isSessionValue(v)) return 'session';
  }
  return 'unknown';
}

function bucketLabel(b: AgyBucket, fallback: string): string {
  let v = b.displayName ?? fallback;
  if (v.endsWith(' Remaining')) v = v.slice(0, -' Remaining'.length);
  if (v === 'Five Hour Limit' || v === '5-hour Limit') return '5 Horas';
  if (v === 'Weekly Limit' || v === 'Weekly limit') return 'Semanal';
  return v;
}

function groupRank(name?: string): number {
  const v = norm(name ?? '');
  if (v.includes('gemini')) return 0;
  if (v.includes('claude') || v.includes('gpt')) return 1;
  return 2;
}

interface Candidate {
  remaining: number;
  resetsAt?: number;
  weekly: boolean;
}

/**
 * Buckets individuais por modelo → os 4 grupos que o painel do Antigravity
 * mostra: Gemini × (5h|semanal), Claude/GPT × (5h|semanal). A janela de cada
 * grupo é a mais apertada (menor `remaining`) — a que limita primeiro.
 */
function windowsFromModelBuckets(buckets: AgyBucket[], now: number): QuotaWindow[] {
  const geminiHourly: Candidate[] = [];
  const geminiWeekly: Candidate[] = [];
  const thirdHourly: Candidate[] = [];
  const thirdWeekly: Candidate[] = [];

  for (const b of buckets) {
    const remaining = bucketFraction(b);
    if (remaining === null || remaining < 0 || remaining > 1) continue;
    const model = norm(bucketId(b));
    if (!model || model.startsWith('chat_')) continue;
    const resetsAt = parseResetMs(b.resetTime);
    const resetIsWeekly =
      resetsAt !== undefined && resetsAt - now > 24 * 3600 * 1000;
    const weekly = cadenceOf(b) === 'weekly' || resetIsWeekly;
    const candidate = { remaining, resetsAt, weekly };
    if (model.includes('gemini')) {
      (weekly ? geminiWeekly : geminiHourly).push(candidate);
    } else if (
      model.includes('claude') ||
      model.includes('gpt') ||
      model.includes('openai')
    ) {
      (weekly ? thirdWeekly : thirdHourly).push(candidate);
    }
  }

  const aggregate = (
    cands: Candidate[],
    label: string,
    weekly: boolean,
  ): QuotaWindow | null => {
    const best = cands.reduce<Candidate | null>(
      (acc, c) => (acc === null || c.remaining < acc.remaining ? c : acc),
      null,
    );
    if (!best) return null;
    return knownWindow({
      kind: weekly ? 'weekly' : 'hours',
      label,
      usedRatio: 1 - best.remaining,
      source: 'provider-api',
      confidence: 'high',
      resetsAt: best.resetsAt,
      now,
    });
  };

  return [
    aggregate(geminiHourly, 'Gemini · 5 Horas', false),
    aggregate(geminiWeekly, 'Gemini · Semanal', true),
    aggregate(thirdHourly, 'Claude/GPT · 5 Horas', false),
    aggregate(thirdWeekly, 'Claude/GPT · Semanal', true),
  ].filter((w): w is QuotaWindow => w !== null);
}

function windowsFromGroup(group: AgyGroup, now: number): QuotaWindow[] {
  const groupName =
    typeof group.displayName === 'string' && group.displayName.trim()
      ? group.displayName.trim()
      : '';
  const sorted = [...(group.buckets ?? [])].sort((a, b) => {
    const rank = (c: Cadence) => (c === 'session' ? 0 : c === 'weekly' ? 1 : 2);
    return rank(cadenceOf(a)) - rank(cadenceOf(b));
  });
  const out: QuotaWindow[] = [];
  for (const b of sorted) {
    if (b.disabled === true) continue;
    const resetsAt = parseResetMs(b.resetTime);
    const weekly = cadenceOf(b) === 'weekly';
    const kind = weekly ? 'weekly' : 'hours';
    const label = bucketLabel(b, bucketId(b, groupName));
    const prefix = groupName ? `${groupName} · ` : '';
    const remaining = bucketFraction(b);
    if (remaining !== null && remaining >= 0 && remaining <= 1) {
      out.push(
        knownWindow({
          kind,
          label: `${prefix}${label}`,
          usedRatio: 1 - remaining,
          source: 'provider-api',
          confidence: 'high',
          resetsAt,
          now,
        }),
      );
      continue;
    }
    const limit = typeof b.limit === 'number' ? b.limit : null;
    const used = typeof b.used === 'number' ? b.used : null;
    if (limit === null || limit <= 0 || used === null || used < 0 || used > limit * 1.5) {
      continue;
    }
    out.push(
      knownWindow({
        kind,
        label: `${prefix}${label}`,
        usedRatio: used / limit,
        source: 'provider-api',
        confidence: 'high',
        resetsAt,
        now,
      }),
    );
  }
  return out;
}

/**
 * `RetrieveUserQuotaSummary` → janelas. `groups` (o que o LS devolve) vence;
 * `buckets` cru por modelo (o que o Cloud Code devolve) é agregado nos 4
 * grupos padrão. [] = payload que não é quota — o chamador cai para a
 * próxima fonte.
 */
export function parseAgyQuotaSummary(body: unknown, now = Date.now()): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    buckets?: AgyBucket[];
    groups?: AgyGroup[];
    quotaGroups?: AgyGroup[];
    response?: { groups?: AgyGroup[] };
    summary?: { groups?: AgyGroup[] };
  };
  const groups =
    root.response?.groups ??
    root.summary?.groups ??
    root.groups ??
    root.quotaGroups;
  if (Array.isArray(groups) && groups.length > 0) {
    const sorted = [...groups].sort(
      (a, b) => groupRank(a.displayName) - groupRank(b.displayName),
    );
    return sorted.flatMap((g) => windowsFromGroup(g, now));
  }
  const buckets = Array.isArray(root.buckets) ? root.buckets : [];
  if (buckets.length === 0) return [];
  if (buckets.some((b) => typeof b.limit === 'number')) {
    // Envelope antigo: used/limit direto, sem agrupamento.
    const out: QuotaWindow[] = [];
    for (const b of buckets) {
      const limit = typeof b.limit === 'number' ? b.limit : null;
      const used = typeof b.used === 'number' ? b.used : null;
      if (limit === null || limit <= 0 || used === null || used < 0 || used > limit * 1.5) {
        continue;
      }
      out.push(
        knownWindow({
          kind: cadenceOf(b) === 'weekly' ? 'weekly' : 'hours',
          label: bucketLabel(b, bucketId(b)),
          usedRatio: used / limit,
          source: 'provider-api',
          confidence: 'high',
          resetsAt: parseResetMs(b.resetTime),
          now,
        }),
      );
    }
    return out;
  }
  return windowsFromModelBuckets(buckets, now);
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

async function postLoopback(
  port: number,
  csrfToken: string | null,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: AGY_BRIDGE_SERVICE,
        method: 'POST',
        // Cert self-signed do LS local — a confiança é pelo processo e pelo
        // token, não pela cadeia TLS. Escopo: só este endpoint de loopback.
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { [AGY_CSRF_HEADER]: csrfToken } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`agy bridge: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('agy bridge: body não é JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('agy bridge: timeout')));
    req.on('error', reject);
    req.end('{"forceRefresh":true}');
  });
}

/**
 * Janelas via language server local do Antigravity (IDE ou `agy` CLI).
 * null quando nenhum está rodando ou nenhum respondeu — o caller segue para
 * o OAuth direto. Só serve a conta que o processo está logado — por isso o
 * chamador só usa na linha nativa (sem accountId), nunca em conta do vault.
 */
export async function fetchAgyBridgeUsage(
  opts: {
    now?: number;
    endpoint?: AgyBridgeEndpoint | null;
    timeoutMs?: number;
    /** Test seam — produção usa postLoopback real. */
    postImpl?: (
      port: number,
      csrfToken: string | null,
      timeoutMs: number,
    ) => Promise<unknown>;
  } = {},
): Promise<QuotaWindow[] | null> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? AGY_BRIDGE_TIMEOUT_MS;
  const post = opts.postImpl ?? postLoopback;
  const endpoint =
    opts.endpoint === undefined ? discoverAgyBridge() : opts.endpoint;
  if (!endpoint) return null;

  for (const port of endpoint.ports) {
    try {
      const body = await post(port, endpoint.csrfToken, timeoutMs);
      const windows = parseAgyQuotaSummary(body, now);
      if (windows.length > 0) return windows;
    } catch {
      // tenta a próxima porta — o LS abre duas e só uma serve este RPC
    }
  }
  return null;
}
