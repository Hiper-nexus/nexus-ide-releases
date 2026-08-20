/**
 * First-wave da Via Rápida: no mesmo turno do Maestro, o Main abre o leque
 * de writers. Missão grande (20 stories) → ~7 assentos. Só CLI com
 * AuthReadiness=present senta — LongCat sem chave não tosta.
 */
import type { SquadAgent } from '../../shared/orch-types';
import {
  canSeat,
  classifySeatAuth,
  seatFailureHint,
  SILENT_REMINT_HINT,
  type SeatAuthReadiness,
  type SeatAuthInput,
} from '../adapters/seat-auth-readiness';
import { MAX_LIVE_PANES_SOFT } from '../../shared/pane-limits';

export const LARGE_MISSION_STORY_THRESHOLD = 6;
export const FIRST_WAVE_WRITER_SEATS = 15;

/**
 * CLIs oferecidas além do roster quando AuthReadiness=present.
 * Claude fica no Maestro; LongCat/unauth nunca entram por aqui.
 */
export const FIRST_WAVE_OFFER_CLIS = [
  'codex',
  'agy',
  'grok',
  'glm',
  'kimi',
] as const;

export type FirstWaveSeat = {
  readonly agent: SquadAgent;
  readonly title: string;
  readonly seatIndex: number;
  readonly storyTitle: string | null;
};

export function isLargeMissionPlan(storyCount: number): boolean {
  return storyCount >= LARGE_MISSION_STORY_THRESHOLD;
}

export function targetFirstWaveWriterSeats(storyCount: number): number {
  if (storyCount <= 0) return 0;
  const softCap = Math.max(1, MAX_LIVE_PANES_SOFT - 1);
  if (isLargeMissionPlan(storyCount)) {
    return Math.min(storyCount, FIRST_WAVE_WRITER_SEATS, softCap);
  }
  return Math.min(storyCount, softCap);
}

export function writableRosterAgents(
  agents: readonly SquadAgent[],
): SquadAgent[] {
  const writers = agents.filter(
    (agent) =>
      agent.category === 'executor' ||
      agent.category === 'scout' ||
      agent.category === 'architect',
  );
  if (writers.length > 0) return writers;
  return agents.filter((agent) => agent.category !== 'orchestrator');
}

export function filterPresentWriterAgents(
  agents: readonly SquadAgent[],
  classify: (agent: SquadAgent) => SeatAuthReadiness = (agent) =>
    classifySeatAuth({
      adapterId: agent.cli,
      authStrategy: (agent as { authStrategy?: string }).authStrategy ?? '',
      hasKey: (agent as { hasKey?: boolean }).hasKey,
    }),
): SquadAgent[] {
  return writableRosterAgents(agents).filter((agent) => canSeat(classify(agent)));
}

/**
 * Assento sem modelo EXPLÍCITO fica sem modelo: o spawn resolve na cadeia
 * req.model → defaultModel do provider (escolha do usuário em Configurações
 * › Providers) → default do adapter. O hardcode antigo
 * (defaultSquadModelForAdapter) entrava como req.model e SOMBREAVA a escolha
 * do usuário — Writer 2 grok subia em grok-4.5 com grok-4.6 configurado
 * (voo real 19/08).
 */
function syntheticWriter(
  cli: string,
  agentName: string,
  id: string,
): SquadAgent {
  return {
    id,
    agentName,
    category: 'executor',
    cli,
  } as SquadAgent;
}

function remintWriterCli(agent: SquadAgent, cli: string): SquadAgent {
  if (agent.cli === cli) return agent;
  // O modelo do papel pertence ao CLI antigo — nunca viaja para o novo.
  // Chave AUSENTE (nunca ''): string vazia estoura o zod min(1) do
  // missionPanes.record depois do pane nascer (gate 0.62).
  const { model: _dropped, ...rest } = agent;
  return { ...rest, cli } as SquadAgent;
}

/**
 * Espalha CLIs present pelos papéis do roster e cria Writer N para o
 * restante. Preferência: agente do squad com o mesmo CLI (GLM reviewer
 * senta se present). Papéis executor sobrando são remintados. Cópias
 * (segundo Codex) vêm depois, em expandFirstWaveSeats.
 */
export function spreadPresentClisAcrossWriterRoles(
  agents: readonly SquadAgent[],
  presentCliIds: readonly string[],
): SquadAgent[] {
  const roles = writableRosterAgents(agents);
  const clis = [
    ...new Set(
      presentCliIds.map((cli) => cli.trim()).filter((cli) => cli.length > 0),
    ),
  ];
  if (clis.length === 0) return [];
  const seated: SquadAgent[] = [];
  const usedIds = new Set<string>();

  for (const cli of clis) {
    const named = agents.find(
      (agent) =>
        agent.category !== 'orchestrator' &&
        agent.cli === cli &&
        !usedIds.has(agent.id),
    );
    if (!named) continue;
    seated.push(named);
    usedIds.add(named.id);
  }

  let writerN = 2;
  for (const cli of clis) {
    if (seated.some((row) => row.cli === cli)) continue;
    const role = roles.find((agent) => !usedIds.has(agent.id));
    if (role) {
      seated.push(remintWriterCli(role, cli));
      usedIds.add(role.id);
      continue;
    }
    seated.push(syntheticWriter(cli, `Writer ${writerN}`, `writer-${cli}`));
    writerN += 1;
  }
  return seated;
}

export function expandFirstWaveSeats(
  writers: readonly SquadAgent[],
  targetSeats: number,
  storyTitles: readonly string[] = [],
): readonly FirstWaveSeat[] {
  if (writers.length === 0 || targetSeats <= 0) return Object.freeze([]);
  const seats: FirstWaveSeat[] = [];
  for (let index = 0; index < targetSeats; index += 1) {
    const agent = writers[index % writers.length]!;
    const copy = Math.floor(index / writers.length);
    const title =
      copy === 0 ? agent.agentName : `${agent.agentName} · ${copy + 1}`;
    const seatedAgent = Object.freeze({
      ...agent,
      id: copy === 0 ? agent.id : `${agent.id}·${copy + 1}`,
      agentName: title,
    }) as SquadAgent;
    seats.push(
      Object.freeze({
        agent: seatedAgent,
        title,
        seatIndex: index,
        storyTitle: storyTitles[index] ?? null,
      }),
    );
  }
  return Object.freeze(seats);
}

function defaultClassify(agent: SquadAgent): SeatAuthReadiness {
  return classifySeatAuth({
    adapterId: agent.cli,
    authStrategy: (agent as { authStrategy?: string }).authStrategy ?? '',
    hasKey: (agent as { hasKey?: boolean }).hasKey,
  });
}

/**
 * Panes que realmente sentam: worker com PTY conectado+writable.
 * Tile de grafo / spawning sem stdin não come o orçamento nem conta
 * como despacho.
 */
export function countLiveFirstWaveWriters(
  panes: readonly {
    readonly missionId?: string | null;
    readonly role?: string | null;
    readonly sessionId?: string | null;
  }[],
  missionId: string,
  isConnectedAndWritable: (sessionId: string) => boolean,
): number {
  return panes.filter(
    (pane) =>
      pane.missionId === missionId &&
      pane.role === 'worker' &&
      typeof pane.sessionId === 'string' &&
      pane.sessionId.length > 0 &&
      isConnectedAndWritable(pane.sessionId),
  ).length;
}

export function planFirstWaveSeats(input: {
  readonly storyCount: number;
  readonly storyTitles?: readonly string[];
  readonly agents: readonly SquadAgent[];
  readonly classifySeat?: (agent: SquadAgent) => SeatAuthReadiness;
  readonly liveWritableWorkers?: number;
  /** CLI already at writer_circuit_break / mortality 3 — do not remint. */
  readonly blockedAdapterIds?: readonly string[];
  /**
   * CLIs present fora do roster (kimi oauth, grok, glm, segundo Codex).
   * Ausente = só o roster, como nos walks que não carregam inventário.
   */
  readonly extraPresentClis?: readonly string[];
  /** CLI do Maestro — não ganha assento de writer extra. */
  readonly orchestratorCli?: string;
}): {
  readonly targetSeats: number;
  readonly presentWriters: readonly SquadAgent[];
  readonly seats: readonly FirstWaveSeat[];
  readonly skippedNoCredential: readonly string[];
} {
  const target = Math.max(
    0,
    targetFirstWaveWriterSeats(input.storyCount) -
      (input.liveWritableWorkers ?? 0),
  );
  const classify = input.classifySeat ?? defaultClassify;
  const allWriters = writableRosterAgents(input.agents);
  const blocked = new Set(
    (input.blockedAdapterIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  const orchestratorCli = input.orchestratorCli?.trim().toLowerCase() ?? '';

  const isPresentCli = (cli: string): boolean =>
    canSeat(classify(syntheticWriter(cli, cli, `probe-${cli}`)));

  const considerCli = (cli: string): boolean => {
    if (!cli || blocked.has(cli)) return false;
    if (orchestratorCli && cli === orchestratorCli) return false;
    return isPresentCli(cli);
  };

  const skipped: string[] = [];
  const recordUnauth = (cli: string): void => {
    if (!cli || blocked.has(cli)) return;
    if (orchestratorCli && cli === orchestratorCli) return;
    if (isPresentCli(cli)) return;
    skipped.push(cli);
  };

  let present: SquadAgent[];
  if (input.extraPresentClis) {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const offer = (cli: string): void => {
      const id = cli.trim();
      if (!id || seen.has(id)) return;
      recordUnauth(id);
      if (!considerCli(id)) return;
      seen.add(id);
      ordered.push(id);
    };
    for (const agent of allWriters) offer(agent.cli);
    for (const cli of input.extraPresentClis) offer(cli);
    present = spreadPresentClisAcrossWriterRoles(input.agents, ordered);
  } else {
    present = filterPresentWriterAgents(input.agents, classify).filter(
      (agent) => !blocked.has(agent.cli),
    );
    for (const agent of allWriters) {
      if (!present.some((row) => row.id === agent.id)) {
        recordUnauth(agent.cli);
      }
    }
  }

  return {
    targetSeats: target,
    presentWriters: present,
    seats: expandFirstWaveSeats(present, target, input.storyTitles ?? []),
    skippedNoCredential: [...new Set(skipped)],
  };
}

export function firstWaveSilentSkipHint(input: SeatAuthInput): string {
  return seatFailureHint({
    readiness: classifySeatAuth(input),
    explicitCivilianPick: false,
    civilianHint: SILENT_REMINT_HINT,
  });
}
