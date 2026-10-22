/**
 * F-787: eventos seguros de ciclo de vida do spawn MCP (pane-spawn-timing e
 * pane-spawn-recovery em main.trace.ndjson). A telemetria anterior gravava
 * tempo/adapter/pane/missão/ok — sem modelo efetivo (48,5% dos spawns aceitos
 * são AUTO, sem adapterId nos argumentos), sem sessionId, sem versão da CLI e
 * sem código estruturado de erro: a saúde histórica da inferência não era
 * reconstruível (auditoria 03/10).
 *
 * Fronteira de conteúdo: só ids, rótulos técnicos, categorias e números.
 * NUNCA prompt, brief, argv, ambiente, conta, fingerprint ou token — as
 * funções aqui nem recebem esses campos.
 */

/** Identidade que o caminho do spawn descobre conforme avança (meta do timer). */
export interface PaneSpawnLifecycleMeta {
  adapterId?: string;
  /** Modelo EFETIVO (rota AUTO inclusa), não o pedido. */
  model?: string;
  paneId?: string;
  sessionId?: string;
  missionId?: string;
  role?: string;
  ok?: boolean;
  /** Entrega a helper vivo e parado (sem spawn novo) — não é rejeição. */
  reused?: boolean;
  cliVersion?: string | null;
  /** Código permanente e estável do erro (classifySpawnErrorCode). */
  errorCode?: string;
  /** F-215: tempos por etapa do materialize da worktree isolada (ms). */
  gitWorktreeMs?: number;
  cowMs?: number;
  /** Writer isolado: `true` = worktree adotada do pool; `false` = criada na hora. */
  pooled?: boolean;
}

export type SpawnInjectionOrigin = 'sistema' | 'maestro' | 'operador';

/**
 * Origem classificada da injeção, sem conteúdo: 'sistema' é o reenvio
 * automático do watchdog (evento pane-spawn-recovery); quem chama com missão
 * (ou já é orquestrador) é o Maestro; o resto é a mão do operador.
 */
export function classifySpawnInjectionOrigin(caller: {
  role?: string | null;
  missionId?: string | null;
}): SpawnInjectionOrigin {
  return caller.role === 'orchestrator' || caller.missionId ? 'maestro' : 'operador';
}

const STABLE_CODE_PREFIX_RE = /^([a-z][a-z0-9_]{2,60}):/i;
const BARE_CODE_RE = /^[a-z][a-z0-9_]{2,60}$/i;

/**
 * Código de erro permanente e estável para o trace — nunca o texto bruto.
 * Códigos snake_case que a própria mensagem já carrega (prefixo `code:` ou a
 * mensagem inteira) são preservados; o resto cai numa tabela de categorias.
 */
export function classifySpawnErrorCode(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  const prefixed = STABLE_CODE_PREFIX_RE.exec(message)?.[1];
  if (prefixed) return prefixed.toLowerCase();
  if (BARE_CODE_RE.test(message)) return message.toLowerCase();
  const m = message.toLowerCase();
  if (m.includes('not authorized')) return 'not_authorized';
  if (m.includes('approval')) return 'approval_required';
  if (m.includes('licença') || m.includes('license')) return 'license_required';
  if (m.includes('writer')) return 'writer_active';
  if (m.includes('renderer')) return 'renderer_unavailable';
  if (m.includes('authority seal')) return 'authority_seal_unavailable';
  if (m.includes('reserva') || m.includes('reservation')) return 'route_reservation';
  if (m.includes('roster') || m.includes('squad')) return 'squad_binding';
  if (m.includes('adapter')) return 'adapter_invalid';
  if (m.includes('cwd') || m.includes('workspace')) return 'scope_violation';
  if (m.includes('quota') || m.includes('cota')) return 'quota_unavailable';
  if (m.includes('pty') || m.includes('spawn')) return 'pty_spawn_failed';
  return 'spawn_failed';
}

/**
 * O evento pane-spawn-timing de toda tentativa MCP: sucesso, rota que falhou
 * antes do PTY, falha de spawn ou exceção interna. `paneCreated` distingue
 * rejeição antes do primeiro turno de pane efetivamente criado.
 */
export function buildPaneSpawnLifecycleEvent(input: {
  meta: PaneSpawnLifecycleMeta;
  caller: {
    role?: string | null;
    missionId?: string | null;
    sessionId?: string | null;
  };
  requestedAdapterId?: string | null;
  requestedMissionId?: string | null;
  totalMs: number;
  phases: Record<string, unknown>;
}): Record<string, unknown> {
  const { meta } = input;
  return {
    kind: 'pane-spawn-timing',
    source: 'mcp',
    adapterId: meta.adapterId ?? input.requestedAdapterId ?? null,
    model: meta.model ?? null,
    paneId: meta.paneId ?? null,
    sessionId: meta.sessionId ?? null,
    callerSessionId: input.caller.sessionId ?? null,
    missionId:
      meta.missionId ?? input.requestedMissionId ?? input.caller.missionId ?? null,
    role: meta.role ?? null,
    origin: classifySpawnInjectionOrigin(input.caller),
    ok: meta.ok === true,
    paneCreated: meta.paneId !== undefined,
    ...(meta.reused ? { reused: true } : {}),
    cliVersion: meta.cliVersion ?? null,
    ...(meta.errorCode ? { errorCode: meta.errorCode } : {}),
    totalMs: input.totalMs,
    phases: input.phases,
    ...(meta.gitWorktreeMs === undefined
      ? {}
      : { gitWorktreeMs: meta.gitWorktreeMs }),
    ...(meta.cowMs === undefined ? {} : { cowMs: meta.cowMs }),
    ...(meta.pooled === undefined ? {} : { pooled: meta.pooled }),
  };
}

/**
 * Tentativa de recuperação automática (watchdog reabre o MESMO pedido em
 * outra CLI) e seu resultado — origem sempre 'sistema'.
 */
export function buildPaneSpawnRecoveryEvent(input: {
  callerSessionId: string;
  excludeAdapterIds: readonly string[];
  paneId?: string | null;
  adapterId?: string | null;
  ok: boolean;
  errorCode?: string;
}): Record<string, unknown> {
  return {
    kind: 'pane-spawn-recovery',
    origin: 'sistema' as const,
    callerSessionId: input.callerSessionId,
    excludeAdapterIds: [...input.excludeAdapterIds],
    paneId: input.paneId ?? null,
    adapterId: input.adapterId ?? null,
    ok: input.ok,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  };
}
