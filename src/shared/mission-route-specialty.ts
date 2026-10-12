/**
 * Specialty routing — the missing axis between "how hard is this?" (task
 * tier) and "which CLI/model should run it?".
 *
 * WHY THIS EXISTS
 * ---------------
 * `classifyTask` only answers complexity. `classifyWorkKind` answers the
 * deliverable type (bug/feature/visual/…) for squads and design authority.
 * Neither one picks a provider. The live router therefore dumped every
 * medium worker on whatever led DEFAULT_ROUTING_TABLE (GLM), including a
 * three-pane fan-out that all resolved before any pane existed.
 *
 * This module is the stable vocabulary the router, the future Nexus
 * benchmark, and the UI can share:
 *   - classify the specialty ONCE
 *   - expose a heuristic prior (honest: not a measurement)
 *   - accept a benchmark table later without changing call sites
 *
 * HONESTY CONTRACT
 * ----------------
 * Heuristic adapter order is a prior, not a score. It must never be labeled
 * `nexus-eval` or `benchmark`. An empty benchmark specialty falls through to
 * the heuristic. `unknown` work with no security overlay is `general` — the
 * complexity table + squad diversity decide, we do not invent a winner.
 */

import { classifyWorkKind, type WorkKind } from './mission-work-kind';

export const ROUTE_SPECIALTIES = [
  'visual',
  'security',
  'bug',
  'feature',
  'doc',
  'ops',
  'general',
] as const;

export type RouteSpecialty = (typeof ROUTE_SPECIALTIES)[number];

export const ROUTE_POLICY_SOURCES = [
  'heuristic',
  'nexus-eval',
  'benchmark',
] as const;

export type RoutePolicySource = (typeof ROUTE_POLICY_SOURCES)[number];

export const ROUTE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type RouteEffort = (typeof ROUTE_EFFORTS)[number];

export interface SpecialtyBenchmarkEntry {
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: RouteEffort;
  /** 0..100. Only meaningful when source is a real benchmark revision. */
  readonly score?: number;
}

export interface SpecialtyBenchmark {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly updatedAt?: string;
  readonly description?: string;
  readonly specialties: Partial<
    Record<RouteSpecialty, readonly SpecialtyBenchmarkEntry[]>
  >;
}

export interface RouteSpecialtyVerdict {
  readonly specialty: RouteSpecialty;
  readonly workKind: WorkKind;
  readonly confidence: 'high' | 'low';
  readonly reason: string;
}

export interface SpecialtyRoutePolicy {
  readonly specialty: RouteSpecialty;
  readonly source: Exclude<RoutePolicySource, 'nexus-eval'>;
  readonly preferAdapterIds: readonly string[];
  /** Minimum reasoning effort; never lowers a stronger table/eval pick. */
  readonly effortFloor?: RouteEffort;
}

/**
 * Empty published table. The eval pipeline will fill `specialties.visual`,
 * `.security`, etc. without a router rewrite. Until then every specialty
 * resolves as heuristic.
 */
export const EMPTY_SPECIALTY_BENCHMARK: SpecialtyBenchmark = Object.freeze({
  schemaVersion: 1,
  source: 'nexus-benchmark/unpublished',
  description:
    'Tabela vazia de propósito: o motor usa heurística até existir benchmark Nexus por especialidade.',
  specialties: Object.freeze({}),
});

/**
 * Uso geral: a heurística de especialidade não prefere provider nenhum. A
 * qualidade vem dos benchmarks oficiais publicados por LLM
 * (src/main/orch/published-benchmarks.ts) e da avaliação Nexus por dimensão
 * quando existir — nunca de uma lista fixa de CLIs por especialidade. O mapa
 * segue aqui porque a API (`preferAdapterIds`) é compartilhada com o caminho
 * de benchmark medido.
 */
export const HEURISTIC_SPECIALTY_ADAPTERS: Readonly<
  Record<RouteSpecialty, readonly string[]>
> = Object.freeze({
  visual: Object.freeze([]),
  security: Object.freeze([]),
  bug: Object.freeze([]),
  feature: Object.freeze([]),
  doc: Object.freeze([]),
  ops: Object.freeze([]),
  general: Object.freeze([]),
});

const HEURISTIC_EFFORT_FLOOR: Readonly<
  Partial<Record<RouteSpecialty, RouteEffort>>
> = Object.freeze({
  security: 'high',
  bug: 'high',
  ops: 'high',
  visual: 'medium',
});

/**
 * Security overlay — a feature/bug that is actually an auth/payment/secret
 * surface should not ride the generic coding ladder. Doc stays doc: writing
 * about auth is still a document.
 */
const SECURITY_SPECIALTY_SIGNALS = [
  'security',
  'cybersecurity',
  'ciberseg',
  'ciberata',
  'segurança',
  'seguranca',
  'vulnerab',
  'oauth',
  'auth',
  'autentica',
  'reautentic',
  'authentica',
  'authoriz',
  'authn',
  'authz',
  'autoriza',
  'payment',
  'pagamento',
  'billing',
  'cobrança',
  'cobranca',
  'encrypt',
  'decrypt',
  'encripta',
  'reencript',
  'desencripta',
  'descriptografa',
  'rls',
  'multitenant',
  'secret',
  // F-1402: superfície de credencial/conta de login é segurança tanto quanto
  // auth/pagamento. 'creden' (radical) cobre credencial/credenciais e
  // credential/credentials. 'login' SOZINHO não entra: "texto do botão de
  // login" é UI, não superfície de credencial — valem as frases compostas.
  'creden',
  'keychain',
  'refresh token',
  'access token',
  'sessão de login',
  'sessao de login',
  'login session',
  'conta gerenciada',
  'managed account',
  'linhagem',
] as const;

/**
 * Sinais casam por PALAVRA INTEIRA por padrão. O prefixo de palavra (F-194)
 * existe para o radical pt-BR colado — 'cript' precisa casar 'criptografia' —
 * mas em palavra inglesa ele casa DENTRO de identificadores e de palavras
 * maiores: 'check' casava 'checkedAt', 'auth' casava 'author', 'doc' casava
 * 'dockerfile', 'log' casava 'login', 'print' casava '--print' (F-1289,
 * 11/10/2026). Um campo de JSON virava tier trivial e um documento de autoria
 * virava critical/security.
 *
 * `stems` é a saída explícita para o que é radical de verdade — o chamador
 * declara, a lista não carrega sintaxe.
 *
 * Fronteira à esquerda: letra, dígito, `_`, `.` e `$` grudados barram o sinal
 * (identificador: `my_check`, `obj.token`, `$token`). Hífen e barra SÃO
 * fronteira ('multi-tenant', 'pre-auth', 'api/auth' — revisão de ponta 12/10),
 * exceto a flag de CLI: hífen(s) abrindo a palavra, depois de início/espaço/
 * pontuação, não é palavra ('--print', '--debug', '-auth').
 */
const WORD_BEFORE = '(?<![\\p{L}\\p{N}_.$])(?<!(?:^|[^\\p{L}\\p{N}])-+)';
const WORD_AFTER = '(?![\\p{L}\\p{N}_])';

const escapeSignal = (signal: string): string =>
  signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactSignalMatchers = new Map<string, RegExp>();
const stemSignalMatchers = new Map<string, RegExp>();

function exactSignalMatcher(signal: string): RegExp {
  let matcher = exactSignalMatchers.get(signal);
  if (!matcher) {
    matcher = new RegExp(`${WORD_BEFORE}${escapeSignal(signal)}${WORD_AFTER}`, 'u');
    exactSignalMatchers.set(signal, matcher);
  }
  return matcher;
}

function stemSignalMatcher(signal: string): RegExp {
  let matcher = stemSignalMatchers.get(signal);
  if (!matcher) {
    matcher = new RegExp(`${WORD_BEFORE}${escapeSignal(signal)}`, 'u');
    stemSignalMatchers.set(signal, matcher);
  }
  return matcher;
}

/** Sinais casados no texto, na ordem da lista (o "porquê" da decisão). */
export function matchSignals(
  text: string,
  signals: readonly string[],
  stems?: ReadonlySet<string>,
): string[] {
  return signals.filter((signal) =>
    (stems?.has(signal) ? stemSignalMatcher(signal) : exactSignalMatcher(signal)).test(text),
  );
}

/**
 * Palavra que só quer dizer tier sozinha COM CONTEXTO (F-1289). Um sinal
 * ambíguo sozinho não decide bucket nenhum — sem um segundo sinal vale o padrão
 * medium (doutrina default-down), e a overlay de segurança deixa o work-kind
 * mandar. A lista é curta e cada entrada tem um caso real:
 *   - 'cobrança': cobrar ENTREGA do worker, não cobrança de dinheiro
 *   - 'texto': 'texto cru' do shell, texto do erro, contexto de prompt
 *   - 'check': 'checkedAt', 'checkout', a checagem que roda a suíte
 *   - 'token': token de contexto, tokenizador, contagem de tokens
 *   - 'produção': produção de vídeo/relatório, não só o deploy
 * ponytail: a ambiguidade real é por TAREFA, não por palavra — isto cobre os
 * casos que já quebraram. Um sinal ambíguo QUEBRADO com vizinho legítimo
 * ('cobrança' + 'cartão de produção', matriz 23/08) continua mandando.
 */
export const AMBIGUOUS_SIGNALS: ReadonlySet<string> = new Set([
  'cobrança',
  'cobranca',
  'texto',
  'check',
  'checks',
  'token',
  'produção',
  'producao',
  'production',
]);

/** Sinais da lista que não são ambíguos: algum deles sustenta a decisão. */
export function decisiveSignals(signals: readonly string[]): string[] {
  return signals.filter((signal) => !AMBIGUOUS_SIGNALS.has(signal));
}

/** Radicais pt-BR/EN que PRECISAM casar por prefixo de palavra. */
const SECURITY_SIGNAL_STEMS: ReadonlySet<string> = new Set([
  'ciberseg',
  'ciberata',
  'vulnerab',
  'autentica',
  'reautentic',
  // Flexão inglesa (revisão de ponta, 12/10): 'authenticated', 'authorized',
  // 'payments', 'pagamentos' — 'auth' segue palavra inteira por causa de 'author'.
  'authentica',
  'authoriz',
  'autoriza',
  'payment',
  'pagamento',
  'oauth',
  'encrypt',
  'decrypt',
  'encripta',
  'reencript',
  'desencripta',
  'descriptografa',
  'secret',
  // F-1402: 'creden' cobre credencial/credenciais/credential/credentials.
  'creden',
]);

export function hasSecuritySpecialtySignals(text: string): boolean {
  const canonical = text.toLowerCase();
  const matched = matchSignals(canonical, SECURITY_SPECIALTY_SIGNALS, SECURITY_SIGNAL_STEMS);
  return decisiveSignals(matched).length > 0;
}

function workKindToSpecialty(kind: WorkKind): RouteSpecialty {
  switch (kind) {
    case 'visual':
    case 'bug':
    case 'feature':
    case 'doc':
    case 'ops':
      return kind;
    default:
      return 'general';
  }
}

/**
 * Compose work-kind + security overlay into the routing specialty.
 * Pure: same bytes in, same bytes out.
 */
export function classifyRouteSpecialty(taskText: string): RouteSpecialtyVerdict {
  const work = classifyWorkKind(taskText);
  const security = hasSecuritySpecialtySignals(taskText);
  if (security && work.kind !== 'doc' && work.kind !== 'visual') {
    return Object.freeze({
      specialty: 'security',
      workKind: work.kind,
      confidence: work.confidence === 'high' || work.kind === 'unknown'
        ? 'high'
        : work.confidence,
      reason: `overlay de segurança sobre work-kind ${work.kind}`,
    });
  }
  const specialty = workKindToSpecialty(work.kind);
  return Object.freeze({
    specialty,
    workKind: work.kind,
    confidence: work.confidence,
    reason: work.reason,
  });
}

const EFFORT_RANK: Readonly<Record<RouteEffort, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
});

export function isRouteEffort(value: string | undefined): value is RouteEffort {
  return (
    typeof value === 'string' &&
    (ROUTE_EFFORTS as readonly string[]).includes(value)
  );
}

/** Raise effort to the specialty floor; never lower a stronger pick. */
export function applyEffortFloor(
  current: string | undefined,
  floor: RouteEffort | undefined,
): string | undefined {
  if (!floor) return current;
  if (!isRouteEffort(current)) return floor;
  return EFFORT_RANK[current] >= EFFORT_RANK[floor] ? current : floor;
}

function uniqueAdapterIds(
  entries: readonly SpecialtyBenchmarkEntry[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of [...entries].sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0),
  )) {
    const id = entry.adapterId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function isRouteSpecialty(value: unknown): value is RouteSpecialty {
  return (
    typeof value === 'string' &&
    (ROUTE_SPECIALTIES as readonly string[]).includes(value)
  );
}

/**
 * Rows only count as a measured prior when the table source is not a
 * placeholder or fixture dump. `unpublished` / `fixture` / `estimate` fall
 * through to the heuristic — otherwise Settings estimates would start
 * steering live routing under a `benchmark` label.
 */
export function specialtyBenchmarkIsMeasured(
  source: string | undefined,
): boolean {
  if (typeof source !== 'string' || source.trim().length === 0) return false;
  const segments = source.toLowerCase().split(/[\/._-]+/);
  return (
    !segments.includes('unpublished') &&
    !segments.includes('fixture') &&
    !segments.includes('estimate')
  );
}

/**
 * Resolve the adapter prior for a specialty. Benchmark rows, when present
 * for THAT specialty AND measured, win. Otherwise the heuristic prior.
 * Never invents scores.
 */
export function resolveSpecialtyPolicy(
  specialty: RouteSpecialty,
  benchmark: SpecialtyBenchmark | null | undefined = EMPTY_SPECIALTY_BENCHMARK,
): SpecialtyRoutePolicy {
  const rows = benchmark?.specialties[specialty];
  if (
    rows &&
    rows.length > 0 &&
    specialtyBenchmarkIsMeasured(benchmark?.source)
  ) {
    const preferAdapterIds = uniqueAdapterIds(rows);
    const topEffort = rows
      .slice()
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0]
      ?.effort;
    return Object.freeze({
      specialty,
      source: 'benchmark',
      preferAdapterIds: Object.freeze(preferAdapterIds),
      effortFloor:
        (isRouteEffort(topEffort) ? topEffort : undefined) ??
        HEURISTIC_EFFORT_FLOOR[specialty],
    });
  }
  return Object.freeze({
    specialty,
    source: 'heuristic',
    preferAdapterIds: HEURISTIC_SPECIALTY_ADAPTERS[specialty],
    effortFloor: HEURISTIC_EFFORT_FLOOR[specialty],
  });
}

/**
 * Stable partition: preferred adapters (policy order) then the rest
 * (original relative order). Empty prefer list is a no-op.
 */
export function preferAdapterOrder<T>(
  items: readonly T[],
  adapterIdOf: (item: T) => string,
  preferred: readonly string[],
): T[] {
  if (preferred.length === 0) return [...items];
  const rank = new Map(preferred.map((id, index) => [id, index]));
  const head: T[] = [];
  const tail: T[] = [];
  for (const item of items) {
    if (rank.has(adapterIdOf(item))) head.push(item);
    else tail.push(item);
  }
  head.sort(
    (left, right) =>
      (rank.get(adapterIdOf(left)) ?? 0) - (rank.get(adapterIdOf(right)) ?? 0),
  );
  return [...head, ...tail];
}
