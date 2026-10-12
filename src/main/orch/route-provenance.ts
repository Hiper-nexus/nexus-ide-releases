/**
 * Proveniência de rota: memória curta das últimas RouteDecisions entregues ao
 * orquestrador, para que o spawn ad-hoc (sem agentName) de modelos com warning
 * de catálogo exija uma decisão real do nexus_route_task em vez de aceitar o
 * default arbitrário da CLI (ex.: grok-4.5). Pure logic — testável sem MCP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/atomic-write';

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
 */
interface MissionlessUse {
  adapterId: string;
  model?: string;
  specialty?: string;
  at: number;
}

const MISSIONLESS_CAP = 128;

let missionlessUses: MissionlessUse[] = [];

// F-1421: a contagem sobrevive a reinícios (o operador reinicia várias vezes
// por dia e o revezamento zerava). JSON em userData, escrita atômica, arquivo
// corrompido/gigante vira lista vazia, janela de 7 dias podada na carga e na
// gravação. Fora do Electron (vitest) não há userData: fica só em memória.
export const MISSIONLESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MISSIONLESS_MAX_FILE_BYTES = 64 * 1024;
const MISSIONLESS_FILENAME = 'missionless-route-uses.json';

let missionlessLoaded = false;
let injectedDir: string | undefined;

/** Para testes: fixa o diretório; `undefined` volta ao userData. Simula reinício. */
export function configureMissionlessPersistence(dir?: string): void {
  injectedDir = dir;
  missionlessUses = [];
  missionlessLoaded = false;
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

function validUse(u: unknown, floor: number): u is MissionlessUse {
  if (!u || typeof u !== 'object') return false;
  const r = u as Record<string, unknown>;
  return (
    typeof r.adapterId === 'string' &&
    r.adapterId.length > 0 &&
    (r.model === undefined || typeof r.model === 'string') &&
    (r.specialty === undefined || typeof r.specialty === 'string') &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    r.at >= floor
  );
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
    const floor = Date.now() - MISSIONLESS_WINDOW_MS;
    const loaded = parsed.filter((u): u is MissionlessUse => validUse(u, floor));
    missionlessUses = [...loaded, ...missionlessUses].slice(-MISSIONLESS_CAP);
  } catch {
    // ausente ou corrompido: começa vazio; a próxima gravação sobrescreve.
  }
}

export function recordMissionlessRouteDecision(
  decision: { adapterId: string; model?: string; specialty?: string },
  at: number = Date.now(),
): void {
  ensureMissionlessLoaded();
  const floor = Date.now() - MISSIONLESS_WINDOW_MS;
  missionlessUses = [
    ...missionlessUses.filter((u) => u.at >= floor).slice(-(MISSIONLESS_CAP - 1)),
    {
      adapterId: decision.adapterId,
      model: decision.model,
      specialty: decision.specialty,
      at,
    },
  ];
  const file = missionlessFile();
  if (!file) return;
  try {
    writeJsonAtomic(file, missionlessUses);
  } catch {
    // persistência é melhor-esforço: a memória do processo continua valendo.
  }
}

/**
 * Usos sem missão desde `sinceMs` — insumo do fair-share. F-1400 (parte 2): a
 * forma espelha `consumedCountsByAdapterSince` do ledger (marcador `visual:`,
 * totais por adapter e `visual:adapter:model` para especialidade visual), para
 * o revezamento de front por modelo valer também fora de missão.
 */
export function missionlessRouteCountsByAdapterSince(sinceMs: number): Map<string, number> {
  ensureMissionlessLoaded();
  const counts = new Map<string, number>([['visual:', 0]]);
  for (const use of missionlessUses) {
    if (use.at < sinceMs) continue;
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
