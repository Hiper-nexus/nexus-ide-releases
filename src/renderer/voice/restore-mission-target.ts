/**
 * "Abre/restaura a missão <nome>" por voz: decide QUAL missão abrir — ou que
 * nenhuma deve abrir ainda. O executor só navega quando esta função devolve
 * `open`; em qualquer dúvida ela devolve `refuse` com a frase para falar.
 *
 * Ordem: o resolvedor local (`mission-name-match`) vê se há uma missão óbvia;
 * só na ambiguidade entra o Jev (superfície `missionPick`, via Main), e a
 * escolha dele só vale se vier válida. Sem decisão, a pessoa é perguntada.
 * Nada aqui escolhe "a primeira da lista" como consolo.
 */
import {
  MAX_AMBIGUOUS_MISSION_CANDIDATES,
  resolveMissionByName,
} from '../../shared/mission-name-match';
import {
  MISSION_PICK_LIMITS,
  type MissionPickRequest,
  type MissionPickResult,
} from '../../shared/mission-pick';

/** A voz não pode ficar muda esperando o Main/Jev: passou disto, vira "sem decisão". */
export const MISSION_PICK_CLIENT_TIMEOUT_MS = 5_000;

const SPOKEN_TITLE_MAX = 60;
const NAMED_IN_QUESTION = 3;

export interface RestorableMission {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly updatedAt?: number;
}

export type RestoreMissionDecision<M extends RestorableMission> =
  | { readonly kind: 'open'; readonly mission: M; readonly say: string }
  | {
      readonly kind: 'refuse';
      readonly reason: 'none' | 'ambiguous';
      readonly say: string;
    };

type MissionPick = (request: MissionPickRequest) => Promise<MissionPickResult | null>;

/**
 * Corta por unidades UTF-16 (o que `z.string().max()` do schema conta), sem
 * partir um par substituto ao meio: 100 emojis seriam 200 unidades e o Main
 * recusaria o pedido inteiro.
 */
function clamp(text: string, maxUnits: number): { text: string; clipped: boolean } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxUnits) return { text: normalized, clipped: false };
  let out = '';
  for (const character of normalized) {
    if (out.length + character.length > maxUnits) break;
    out += character;
  }
  return { text: out.trimEnd(), clipped: true };
}

function spokenTitle(title: string): string {
  const { text, clipped } = clamp(title, SPOKEN_TITLE_MAX);
  return clipped ? `${text}…` : text;
}

/** "A", "A e B", "A, B e C". */
function joinNatural(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

/**
 * Pede o desempate ao Main. Nunca lança e nunca espera sem teto: ponte
 * ausente, erro, demora ou turno cancelado viram `null` ("sem decisão"). O
 * cancelamento resolve na hora, para o executor não esperar o teto de 5 s só
 * para descobrir que o turno já morreu.
 */
export async function requestMissionPick(
  request: MissionPickRequest,
  signal?: AbortSignal,
): Promise<MissionPickResult | null> {
  const bridge = typeof window === 'undefined' ? undefined : window.nexus?.jev;
  if (typeof bridge?.missionPick !== 'function' || signal?.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      bridge.missionPick(request),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MISSION_PICK_CLIENT_TIMEOUT_MS);
        onAbort = () => resolve(null);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function toPickRequest(
  wanted: string,
  candidates: readonly RestorableMission[],
): MissionPickRequest {
  return {
    spoken: clamp(wanted, MISSION_PICK_LIMITS.spokenMax).text,
    candidates: candidates.map((mission) => ({
      title: clamp(mission.title, MISSION_PICK_LIMITS.titleMax).text,
      state: mission.state,
      ...(mission.updatedAt === undefined ? {} : { updatedAt: mission.updatedAt }),
    })),
  };
}

/** Só uma posição inteira dentro da lista enviada vale; o resto é "sem decisão". */
function pickedIndex(answer: MissionPickResult | null, count: number): number | null {
  if (answer?.decision !== 'picked') return null;
  const { index } = answer;
  return Number.isInteger(index) && index >= 0 && index < count ? index : null;
}

async function askJev(
  wanted: string,
  candidates: readonly RestorableMission[],
  pick: MissionPick,
): Promise<number | null> {
  try {
    return pickedIndex(await pick(toPickRequest(wanted, candidates)), candidates.length);
  } catch {
    return null;
  }
}

function noneSay(missions: readonly RestorableMission[]): string {
  if (missions.length === 0) return 'Não tem nenhuma missão salva para abrir.';
  const shown = missions
    .slice(0, MAX_AMBIGUOUS_MISSION_CANDIDATES)
    .map((mission) => spokenTitle(mission.title));
  const left = missions.length - shown.length;
  const list = left > 0 ? `${shown.join(', ')} e mais ${left}` : shown.join(', ');
  return `Não achei nenhuma missão com esse nome. Você tem: ${list}.`;
}

function askWhichSay(titles: readonly string[], total: number): string {
  const named = titles.slice(0, NAMED_IN_QUESTION).map(spokenTitle);
  const lead = total > named.length ? `${total} missões parecidas, como` : `${total} missões parecidas:`;
  return `Achei ${lead} ${joinNatural(named)}. Qual delas?`;
}

export async function decideRestoreMission<M extends RestorableMission>(
  wanted: string | undefined,
  missions: readonly M[],
  pick: MissionPick = requestMissionPick,
): Promise<RestoreMissionDecision<M>> {
  const resolution = resolveMissionByName(wanted, missions);
  if (resolution.kind === 'none') {
    return { kind: 'refuse', reason: 'none', say: noneSay(missions) };
  }
  if (resolution.kind === 'unique') {
    return {
      kind: 'open',
      mission: resolution.mission,
      say: `Abrindo os terminais da missão ${spokenTitle(resolution.mission.title)}.`,
    };
  }

  const candidates = resolution.candidates.map((candidate) => candidate.mission);
  const index = await askJev(wanted ?? '', candidates, pick);
  const chosen = index === null ? undefined : candidates[index];
  if (chosen) {
    return {
      kind: 'open',
      mission: chosen,
      say: `Abrindo a missão ${spokenTitle(chosen.title)}, a mais parecida com o que você disse.`,
    };
  }
  return {
    kind: 'refuse',
    reason: 'ambiguous',
    say: askWhichSay(
      candidates.map((mission) => mission.title),
      resolution.total,
    ),
  };
}
