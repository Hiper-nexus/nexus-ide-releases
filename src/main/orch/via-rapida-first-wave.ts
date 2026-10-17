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
 * Ordem preferida da oferta além do roster; o inventário instalado completa
 * o leque. Só AuthReadiness=present senta, sem assento extra para o Maestro.
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

/** Integrantes a quem se pergunta — inclui revisor. Maestro fica de fora. */
export function rosterAskAgents(
  agents: readonly SquadAgent[],
): SquadAgent[] {
  return agents.filter((agent) => agent.category !== 'orchestrator');
}

/**
 * Missão-pergunta: UM pane por integrante do roster, sem Writer N extra e
 * sem colapsar em 1 escritor porque o plano selado tem 1 título.
 */
export function planMetaPaneAskSeats(input: {
  readonly agents: readonly SquadAgent[];
  readonly classifySeat?: (agent: SquadAgent) => SeatAuthReadiness;
  readonly blockedAdapterIds?: readonly string[];
  readonly seatedKeys?: readonly string[];
}): {
  readonly targetSeats: number;
  readonly seats: readonly FirstWaveSeat[];
  readonly skippedNoCredential: readonly string[];
} {
  const classify = input.classifySeat ?? defaultClassify;
  const blocked = new Set(
    (input.blockedAdapterIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  const seated = new Set(
    (input.seatedKeys ?? []).map((key) => key.trim()).filter(Boolean),
  );
  const skipped: string[] = [];
  const present: SquadAgent[] = [];
  for (const agent of rosterAskAgents(input.agents)) {
    if (seated.has(agent.id) || seated.has(agent.agentName)) continue;
    if (blocked.has(agent.cli) || !canSeat(classify(agent))) {
      skipped.push(agent.cli);
      continue;
    }
    present.push(agent);
  }
  return {
    targetSeats: present.length,
    seats: expandFirstWaveSeats(
      present,
      present.length,
      present.map((agent) => agent.agentName),
    ),
    skippedNoCredential: [...new Set(skipped)],
  };
}

function normSeatKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Non-orchestrator live panes on this mission — extras included. */
export function liveMissionWorkerCount(
  panes: readonly {
    readonly missionId?: string;
    readonly role?: string;
    readonly state?: string;
  }[],
  missionId: string,
): number {
  return panes.filter(
    (pane) =>
      pane.missionId === missionId &&
      pane.state !== 'exited' &&
      pane.role !== 'orchestrator',
  ).length;
}

/** Live worker titles/names that occupy a meta-pane roster seat. */
export function liveWorkerSeatKeys(
  panes: readonly {
    readonly missionId?: string;
    readonly role?: string;
    readonly state?: string;
    readonly agentName?: string;
    readonly title?: string;
  }[],
  missionId: string,
): string[] {
  return panes
    .filter(
      (pane) =>
        pane.missionId === missionId &&
        pane.role === 'worker' &&
        pane.state !== 'exited',
    )
    .flatMap((pane) =>
      [pane.agentName, pane.title].filter(
        (key): key is string => typeof key === 'string' && key.length > 0,
      ),
    );
}

/**
 * Hard seating gate for ask-the-team: first-wave already opened one pane per
 * roster member. Maestro may fill a missing named seat; ad-hoc / unnamed /
 * already-seated copies are refused. Prompt-only "NÃO spawne" is not enough
 * (DEV 24/08: undefined/kimi + undefined/codex on 2x2).
 */
export function decideMetaPaneWorkerSpawn(input: {
  readonly isMetaPaneMission: boolean;
  readonly requestedAgentName?: string | null;
  readonly rosterWorkerNames: readonly string[];
  readonly liveWorkerKeys: readonly string[];
  readonly liveWorkerCount?: number;
}):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string } {
  if (!input.isMetaPaneMission) return { allowed: true };
  const live = new Set(
    input.liveWorkerKeys.map(normSeatKey).filter((key) => key.length > 0),
  );
  const roster = input.rosterWorkerNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const liveCount = Math.max(input.liveWorkerCount ?? live.size, live.size);
  if (roster.length > 0 && liveCount >= roster.length) {
    return {
      allowed: false,
      reason:
        'meta_pane_spawn_refused: roster seats are already live; ' +
        'use nexus_pane_ask — do not spawn extra panes',
    };
  }
  const requested = input.requestedAgentName?.trim() ?? '';
  if (!requested) {
    return {
      allowed: false,
      reason:
        'meta_pane_spawn_refused: first-wave already seated this ask; ' +
        'use nexus_pane_ask on an existing pane — ad-hoc spawn is forbidden',
    };
  }
  const requestedNorm = normSeatKey(requested);
  if (!roster.some((name) => normSeatKey(name) === requestedNorm)) {
    return {
      allowed: false,
      reason:
        `meta_pane_spawn_refused: "${requested}" is not a roster member; ` +
        'use nexus_pane_ask on an existing pane',
    };
  }
  if (live.has(requestedNorm)) {
    return {
      allowed: false,
      reason:
        `meta_pane_spawn_refused: ${requested} already has a live pane; ` +
        'use nexus_pane_ask — do not spawn again',
    };
  }
  return { allowed: true };
}

export function filterPresentWriterAgents(
  agents: readonly SquadAgent[],
  classify: (agent: SquadAgent) => SeatAuthReadiness = (agent) =>
    classifySeatAuth({
      adapterId: agent.cli,
      authStrategy: (agent as { authStrategy?: string }).authStrategy ?? '',
      hasKey: (agent as { hasKey?: boolean }).hasKey,
      credentialReadiness: (agent as { credentialReadiness?: string }).credentialReadiness,
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
    const unusedOn = (agent: SquadAgent): boolean =>
      agent.cli === cli && !usedIds.has(agent.id);
    // F-1501: o escritor do roster nessa CLI (quem originou a oferta) senta
    // primeiro, em qualquer ordem do roster; o revisor só pega o assento da
    // CLI que nenhum escritor tem. Antes, um Revisor listado antes do
    // Executor sentava e o Executor era remintado em outra CLI sem o modelo.
    const named =
      roles.find(unusedOn) ??
      agents.find((agent) => agent.category !== 'orchestrator' && unusedOn(agent));
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
      credentialReadiness: (agent as { credentialReadiness?: string }).credentialReadiness,
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
  /**
   * F-784: panes novos que cabem agora (orçamento de paralelismo: panes de
   * agente vivos × teto da RAM × memória livre). A onda abre todas as
   * histórias até esse teto, nunca além. Ausente = sem teto da máquina.
   */
  readonly maxNewSeats?: number;
}): {
  readonly targetSeats: number;
  readonly presentWriters: readonly SquadAgent[];
  readonly seats: readonly FirstWaveSeat[];
  readonly skippedNoCredential: readonly string[];
} {
  const byStories = Math.max(
    0,
    targetFirstWaveWriterSeats(input.storyCount) -
      (input.liveWritableWorkers ?? 0),
  );
  const target =
    input.maxNewSeats === undefined
      ? byStories
      : Math.min(byStories, Math.max(0, input.maxNewSeats));
  const classify = input.classifySeat ?? defaultClassify;
  const allWriters = writableRosterAgents(input.agents);
  const blocked = new Set(
    (input.blockedAdapterIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  const orchestratorCli = input.orchestratorCli?.trim().toLowerCase() ?? '';

  const isPresentCli = (cli: string): boolean =>
    canSeat(classify(syntheticWriter(cli, cli, `probe-${cli}`)));

  // F-1501: a CLI do Maestro só fica de fora do assento EXTRA. Integrante do
  // roster nessa CLI foi escolha do usuário: num squad todo Codex, descartá-lo
  // remintava o Executor em outra CLI, sem o modelo escolhido.
  const isMaestroExtra = (cli: string, fromRoster: boolean): boolean =>
    !fromRoster && orchestratorCli !== '' && cli === orchestratorCli;

  const considerCli = (cli: string, fromRoster: boolean): boolean => {
    if (!cli || blocked.has(cli)) return false;
    if (isMaestroExtra(cli, fromRoster)) return false;
    return isPresentCli(cli);
  };

  const skipped: string[] = [];
  const recordUnauth = (cli: string, fromRoster: boolean): void => {
    if (!cli || blocked.has(cli)) return;
    if (isMaestroExtra(cli, fromRoster)) return;
    if (isPresentCli(cli)) return;
    skipped.push(cli);
  };

  let present: SquadAgent[];
  if (input.extraPresentClis) {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const offer = (cli: string, fromRoster: boolean): void => {
      const id = cli.trim();
      if (!id || seen.has(id)) return;
      recordUnauth(id, fromRoster);
      if (!considerCli(id, fromRoster)) return;
      seen.add(id);
      ordered.push(id);
    };
    for (const agent of allWriters) offer(agent.cli, true);
    for (const cli of input.extraPresentClis) offer(cli, false);
    present = spreadPresentClisAcrossWriterRoles(input.agents, ordered);
  } else {
    present = filterPresentWriterAgents(input.agents, classify).filter(
      (agent) => !blocked.has(agent.cli),
    );
    for (const agent of allWriters) {
      if (!present.some((row) => row.id === agent.id)) {
        recordUnauth(agent.cli, true);
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
