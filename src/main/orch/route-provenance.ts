/**
 * Proveniência de rota: memória curta das últimas RouteDecisions entregues ao
 * orquestrador, para que o spawn ad-hoc (sem agentName) de modelos com warning
 * de catálogo exija uma decisão real do nexus_route_task em vez de aceitar o
 * default arbitrário da CLI (ex.: grok-4.5). Pure logic — testável sem MCP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicAsync } from '../util/atomic-write';

export interface RouteProvenanceEntry {
  adapterId: string;
  model?: string;
}

export interface SpawnGateModelInfo {
  warning?: string;
}

// Limitação aceita (Onda 0): ring ÚNICO do processo main, sem escopo por
// missão, sem TTL e sem consumo — uma decisão recente autoriza o mesmo
// adapter+model para qualquer missão até ser evictada. O enforcement completo
// (reserva por missão, expiração) é a Fase 2 do plano do dossiê.
const RECENT_CAP = 16;

let recentDecisions: RouteProvenanceEntry[] = [];

export function clearRouteProvenance(): void {
  recentDecisions = [];
  missionlessUses = [];
  missionlessLoaded = false;
  resetRouteProvenancePersistence();
  const file = missionlessFile();
  if (file) fs.rmSync(file, { force: true });
}

/**
 * Memória curta de rotas SEM missão (F-1291). Reserva de rota só nasce com
 * missionId, então o spawn do operador nunca aparecia em
 * `consumedRouteCountsByAdapterSince` e o fair-share global era no-op fora de
 * missão — a mesma CLI repetia para sempre. Cada decisão sem missão (nunca
 * sugestão do hook) soma 1 aqui, com timestamp para a janela de 7 dias.
 *
 * Limitação herdada do ring acima: memória do processo main, sem escopo por
 * checkout. Para o fair-share (gap 2 em 7 dias) o sinal entre checkouts é
 * desprezível; a alternativa seria não contar nada — o bug.
 *
 * F-232 (2ª rodada): a mesma pane passava a contar DUAS vezes — a decisão sem
 * missão do `nexus_route_task` e o spawn físico registrado em
 * `spawnAgentSession`. Agora o spawn consome a decisão pendente do mesmo adapter
 * (`kind`), e uma decisão que nunca virou pane para de contar depois da validade.
 */
export interface DurableRouteUse {
  adapterId: string;
  model?: string;
  specialty?: string;
  sessionId?: string;
  at: number;
  /**
   * `decision` = nexus_route_task sem missão (ainda sem pane físico);
   * `spawn` = pane de agente CLI nascido de verdade. Ausente = arquivo escrito
   * antes do campo existir, desfeito por `entryKind` a partir do sessionId.
   */
  kind?: 'decision' | 'spawn';
}

/**
 * Capacidade medida (F-232): o teto de 128 came de um ring de processo, mas o
 * armazenamento é durável e o uso real é ~350 spawns em 7 dias com retenção de
 * 30 — o ceiling antigo descartava uso recente e subestimava o fair-share.
 * 4096 cabe folgado nos 30 dias de retenção mesmo com o JSON indentado.
 */
export const MISSIONLESS_CAP = 4096;

let missionlessUses: DurableRouteUse[] = [];

// F-1421 / F-232: a contagem sobrevive a reinícios (o operador reinicia várias
// vezes por dia e o revezamento zerava). JSON em userData, escrita atômica,
// arquivo corrompido/gigante vira lista vazia. Janela de retenção/prune de 30 dias
// na carga e na gravação; consultas de fair-share filtram pela janela ativa (7 dias).
export const MISSIONLESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ROUTE_USE_PRUNE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Validade de uma decisão sem pane: dentro dela a decisão conta (provisória, o
 * spawn pode estar a caminho) e o spawn que chegar consome a linha; depois
 * dela some da contagem, porque uma consulta ao router que nunca virou pane não
 * pode inflar o fair-share para sempre.
 */
export const DECISION_GRACE_MS = 120_000;
const MISSIONLESS_MAX_FILE_BYTES = 1024 * 1024;
const MISSIONLESS_FILENAME = 'missionless-route-uses.json';

let missionlessLoaded = false;
let injectedDir: string | undefined;

/** Para testes: fixa o diretório; `undefined` volta ao userData. Simula reinício. */
export function configureMissionlessPersistence(dir?: string): void {
  injectedDir = dir;
  missionlessUses = [];
  missionlessLoaded = false;
  // A memória zerou: gravação pendente de antes gravaria a lista vazia por cima do arquivo.
  resetRouteProvenancePersistence();
}

function missionlessFile(): string | null {
  if (injectedDir) return path.join(injectedDir, MISSIONLESS_FILENAME);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fora do Electron (vitest) `app` não existe
    const electron = require('electron') as { app?: { getPath(name: 'userData'): string } };
    if (typeof electron?.app?.getPath !== 'function') return null;
    return path.join(electron.app.getPath('userData'), MISSIONLESS_FILENAME);
  } catch {
    return null;
  }
}

function validUse(u: unknown, floor: number): u is DurableRouteUse {
  if (!u || typeof u !== 'object') return false;
  const r = u as Record<string, unknown>;
  return (
    typeof r.adapterId === 'string' &&
    r.adapterId.length > 0 &&
    (r.model === undefined || typeof r.model === 'string') &&
    (r.specialty === undefined || typeof r.specialty === 'string') &&
    (r.sessionId === undefined || typeof r.sessionId === 'string') &&
    (r.kind === undefined || r.kind === 'decision' || r.kind === 'spawn') &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    r.at >= floor
  );
}

/** `kind` ausente = arquivo anterior ao campo: a linha com sessionId É um spawn, a sem sessionId é uma decisão. */
function entryKind(use: DurableRouteUse): 'decision' | 'spawn' {
  return use.kind ?? (use.sessionId ? 'spawn' : 'decision');
}

// F-764 / N1: a persistência síncrona com fsync a cada spawn bloqueava o main
// ~13 ms por chamada. Agora marcamos sujo e a gravação assíncrona (writeFileAtomicAsync)
// roda coalescida com debounce de ~1.5 s (timer.unref). O flush no início do
// shutdown garante que nada se perde. A contagem em memória continua
// autoritativa — consultas de fair-share não esperam disco.
//
// Invariante: sujo ⇒ o contador foi carregado (só os writers marcam sujo, e
// depois de ensureMissionlessLoaded). Por isso flush sem sujeira não grava: a
// memória de uma sessão que nunca carregou o contador (só retomou panes) é a
// lista vazia, e gravá-la apagaria o arquivo.
const PERSIST_DEBOUNCE_MS = 1500;
let persistDirty = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
// Fila única: duas gravações nunca correm juntas, então a do snapshot mais novo publica por último.
let persistChain: Promise<void> = Promise.resolve();
// Sobe a cada reset: gravação enfileirada ou em voo de antes do reset desiste e não recria o arquivo.
// ponytail: a cerca fica antes do rename; um rename já despachado ao pool não se cancela (só testes resetam).
let persistEpoch = 0;

/** Tira o snapshot agora (a sujeira vai junto com ele) e o põe na fila; não espera o disco. */
function persistSnapshotNow(): void {
  persistDirty = false;
  const file = missionlessFile();
  if (!file) return;
  const body = JSON.stringify(missionlessUses, null, 2);
  const epoch = persistEpoch;
  const stillCurrent = (): void => {
    if (epoch !== persistEpoch) throw new Error('route-provenance: gravação obsoleta');
  };
  persistChain = persistChain
    .then(() => {
      stillCurrent();
      return writeFileAtomicAsync(file, body, undefined, { beforeCommit: stillCurrent });
    })
    // persistência é melhor-esforço: a memória do processo continua valendo.
    .catch(() => undefined);
}

function persistSchedule(): void {
  persistDirty = true;
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    persistSnapshotNow();
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref();
}

/**
 * Grava o que estiver sujo sem esperar o debounce e aguarda a fila esvaziar.
 * Chamado no início do shutdown do app (a admissão de spawn já está selada, não
 * entra registro novo) e em testes que simulam reinício.
 */
export async function flushRouteProvenance(): Promise<void> {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  if (persistDirty) persistSnapshotNow();
  await persistChain;
}

/** Descarta o que está pendente (timer, sujeira, gravações na fila ou em voo) sem tocar no disco. */
export function resetRouteProvenancePersistence(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  persistDirty = false;
  persistEpoch += 1;
}

function ensureMissionlessLoaded(): void {
  if (missionlessLoaded) return;
  missionlessLoaded = true;
  const file = missionlessFile();
  if (!file) return;
  try {
    if (fs.statSync(file).size > MISSIONLESS_MAX_FILE_BYTES) return;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return;
    const floor = Date.now() - ROUTE_USE_PRUNE_WINDOW_MS;
    const loaded = parsed.filter((u): u is DurableRouteUse => validUse(u, floor));
    missionlessUses = [...loaded, ...missionlessUses].slice(-MISSIONLESS_CAP);
  } catch {
    // ausente ou corrompido: começa vazio; a próxima gravação sobrescreve.
  }
}

/**
 * Registra o nascimento físico de um pane de agente CLI de IA no contador durável.
 * Ocorre no ponto único de spawn de agente (spawnAgentSession), independente
 * do ciclo de vida da missão.
 *
 * Consome a decisão pendente do MESMO adapter quando ela existe (F-232): o
 * `nexus_route_task` sem missão e o spawn físico do mesmo pane contavam 2×. A
 * linha absorve o sessionId e o instante do spawn, guarda a specialty da
 * decisão (revezamento visual por modelo) e vira `spawn` — um pane, uma linha.
 */
export function recordAgentSpawn(
  spawn: { adapterId: string; model?: string; specialty?: string; sessionId?: string },
  at: number = Date.now(),
): void {
  ensureMissionlessLoaded();
  const floor = Date.now() - ROUTE_USE_PRUNE_WINDOW_MS;
  const kept = missionlessUses.filter((u) => u.at >= floor);
  const pending = findPendingDecision(kept, spawn.adapterId, at);
  if (pending >= 0) {
    const decision = kept[pending];
    kept[pending] = {
      ...decision,
      adapterId: spawn.adapterId,
      model: spawn.model ?? decision.model,
      sessionId: spawn.sessionId ?? decision.sessionId,
      at,
      kind: 'spawn',
    };
    missionlessUses = kept.slice(-MISSIONLESS_CAP);
    persistSchedule();
    return;
  }
  missionlessUses = [
    ...kept.slice(-(MISSIONLESS_CAP - 1)),
    {
      adapterId: spawn.adapterId,
      model: spawn.model,
      specialty: spawn.specialty,
      sessionId: spawn.sessionId,
      at,
      kind: 'spawn',
    },
  ];
  persistSchedule();
}

/** Índice da decisão pendente (sem sessionId, dentro da validade) mais recente do adapter, ou -1. */
function findPendingDecision(
  uses: readonly DurableRouteUse[],
  adapterId: string,
  at: number,
): number {
  for (let i = uses.length - 1; i >= 0; i -= 1) {
    const use = uses[i];
    if (!use || use.adapterId !== adapterId || use.sessionId) continue;
    if (entryKind(use) !== 'decision') continue;
    if (at - use.at > DECISION_GRACE_MS) continue;
    return i;
  }
  return -1;
}

export function recordMissionlessRouteDecision(
  decision: { adapterId: string; model?: string; specialty?: string },
  at: number = Date.now(),
): void {
  ensureMissionlessLoaded();
  const floor = Date.now() - ROUTE_USE_PRUNE_WINDOW_MS;
  missionlessUses = [
    ...missionlessUses.filter((u) => u.at >= floor).slice(-(MISSIONLESS_CAP - 1)),
    {
      adapterId: decision.adapterId,
      model: decision.model,
      specialty: decision.specialty,
      at,
      kind: 'decision',
    },
  ];
  persistSchedule();
}

/**
 * Lista entradas do contador durável para inspeção/testes.
 */
export function listDurableRouteUses(sinceMs: number = 0): readonly DurableRouteUse[] {
  ensureMissionlessLoaded();
  return missionlessUses.filter((u) => u.at >= sinceMs);
}

/**
 * Usos desde `sinceMs` — insumo do fair-share. F-1400 (parte 2): a forma espelha
 * `consumedCountsByAdapterSince` do ledger (marcador `visual:`, totais por adapter
 * e `visual:adapter:model` para especialidade visual).
 * Opcionalmente exclui sessionIds já computados por outros ledgers para evitar contagem dupla.
 */
export function missionlessRouteCountsByAdapterSince(
  sinceMs: number,
  excludeSessionIds?: ReadonlySet<string>,
): Map<string, number> {
  ensureMissionlessLoaded();
  const counts = new Map<string, number>([['visual:', 0]]);
  const now = Date.now();
  for (const use of missionlessUses) {
    if (use.at < sinceMs) continue;
    if (use.sessionId && excludeSessionIds?.has(use.sessionId)) continue;
    // Decisão sem pane confirmado é provisória: vale enquanto a validade não
    // expira (o spawn pode estar a caminho) e some depois — uma consulta ao
    // router que nunca virou pane não conta para sempre.
    if (entryKind(use) === 'decision' && now - use.at > DECISION_GRACE_MS) continue;
    counts.set(use.adapterId, (counts.get(use.adapterId) ?? 0) + 1);
    if (use.specialty === 'visual' && use.model) {
      const key = `visual:${use.adapterId}:${use.model}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

export function recordRouteDecision(decision: RouteProvenanceEntry): void {
  recentDecisions = [
    ...recentDecisions.slice(-(RECENT_CAP - 1)),
    { adapterId: decision.adapterId, model: decision.model },
  ];
}

export function hasRecentRouteMatch(adapterId: string, model?: string): boolean {
  return recentDecisions.some(
    (entry) => entry.adapterId === adapterId && entry.model === model,
  );
}

/**
 * Retorna a mensagem de erro que o handler de spawn ad-hoc deve lançar, ou
 * null quando o spawn pode prosseguir. Só gateia modelo EXPLÍCITO com warning
 * de catálogo e sem decisão recente do router — spawns de roster (agentName)
 * e modelos limpos nunca passam por aqui.
 */
export function adHocSpawnGateError(
  adapterId: string,
  model: string | undefined,
  info: SpawnGateModelInfo | null | undefined,
): string | null {
  if (!model || !info?.warning) return null;
  if (hasRecentRouteMatch(adapterId, model)) return null;
  return (
    `route_required: o modelo ${adapterId}:${model} tem warning de catálogo ` +
    `("${info.warning}") e não veio de uma decisão do router. Chame ` +
    'nexus_route_task e spawne com o adapter/model/effort retornados (o ' +
    'router escolhe um modelo avaliado/estável). Se este modelo específico ' +
    'for realmente necessário, o usuário deve selecioná-lo manualmente pela UI.'
  );
}
