import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PaneRuntimeState } from '../../shared/orch-types';
import { redactTerminalText } from '../../shared/secret-redaction';
import { redactSecrets, redactState } from '../decision-models/decision-redaction';
import {
  isJevUnavailableReason,
  parseSpawnRouteConfidence,
  parseSpawnRuleChoice,
  type SpawnRouteConfidence,
  type SpawnRouteInfo,
  type SpawnRuleChoiceReceipt,
} from '../../shared/spawn-route';

/**
 * Peças do spawn da mão do operador sempre roteado (A, 25/09): o agente
 * descreve a tarefa, o Jev + tabela escolhem CLI/modelo/esforço.
 */

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Texto que o roteador classifica: task, senão prompt, senão title. */
export function operatorRouteTask(args: Record<string, unknown>): string | null {
  return nonBlank(args.task) ?? nonBlank(args.prompt) ?? nonBlank(args.title) ?? null;
}

/**
 * F-1316 (revisão Fable): só é brief o caminho que a linha APONTA ("Leia e
 * siga o brief em …", "follow …"). Menção solta a um arquivo não é brief.
 */
const BRIEF_POINTER_RE =
  /(?<![\p{L}\p{N}])(?:leia|ler|lê|siga|seguir|segue|read|follow|consulte|veja|see|abra|open|brief)(?![\p{L}\p{N}])/iu;
/** Manifesto/config não é brief mesmo apontado: só despeja dependências no classificador. */
const NON_BRIEF_FILE_RE = /^(?:package(?:-lock)?|npm-shrinkwrap|tsconfig(?:\.[^/\\]+)?|jsconfig)\.json$/i;
const BRIEF_MAX_BYTES = 64 * 1024;
const BRIEF_MAX_FILES = 4;

/**
 * Segredos em prosa de brief que os padrões de `shared/secret-redaction` (via
 * redactTerminalText) e do `decision-redaction` não pegam: segredo de webhook
 * (`whsec_…`), valor de cookie (`cookie: "session=…"`) e senha rotulada em
 * prosa ("Senha do banco de produção: hunter2"). Só vale para o texto que vai
 * ao classificador — redigir a mais aqui não custa nada à rota.
 */
const BRIEF_EXTRA_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, '[REDACTED]'],
  [/((?:set-)?cookie["']?\s*[:=]\s*["']?)[A-Za-z0-9_.-]+=[^\n"']*/gi, '$1[REDACTED]'],
  [/((?:senha|password|passwd|passphrase|pwd)\b[^\n:=]{0,48}[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]'],
];

function redactBriefText(content: string): string {
  let text = redactSecrets(redactTerminalText(content));
  for (const [pattern, replacement] of BRIEF_EXTRA_SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/** userData/briefs: onde o PTY grava o brief longo do spawn (`pty-manager`). */
function userDataBriefsDir(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fora do Electron (vitest) `app` não existe
    const electron = require('electron') as { app?: { getPath(name: 'userData'): string } };
    if (typeof electron?.app?.getPath !== 'function') return undefined;
    return path.join(electron.app.getPath('userData'), 'briefs');
  } catch {
    return undefined;
  }
}

function isInside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface RouteBriefOptions {
  /** Raízes do projeto (checkout e worktree de execução) onde um brief pode viver. */
  readonly projectRoots: readonly string[];
  /** Teste: substitui userData/briefs. */
  readonly briefsDir?: string;
  /** Recibo: brief apontado que não entrou (teto, fora da raiz) — nunca some calado. */
  readonly skipped?: string[];
}

/** F-1316: file contents are classification input only, never a durable task. */
export async function routeTaskWithBrief(
  task: string,
  prompt: string | undefined,
  options: RouteBriefOptions,
): Promise<string> {
  const references = `${task}\n${prompt ?? ''}`.slice(0, 128 * 1024);
  const pattern = /["'`]([^"'`\r\n]+\.(?:md|json))["'`]|(?:^|[\s(])((?:\/|[A-Za-z]:[\\/])[^\s"'`<>()[\]]+\.(?:md|json))(?=$|[\s,;!?:)\]>]|\.(?:\s|$))/gi;
  const roots: string[] = [];
  for (const root of [...options.projectRoots, options.briefsDir ?? userDataBriefsDir()]) {
    if (!root) continue;
    try {
      roots.push(await realpath(root));
    } catch {
      // Raiz que não existe não autoriza nada.
    }
  }
  const skip = (file: string, reason: string) => options.skipped?.push(`${file} (${reason})`);
  const seen = new Set<string>();
  let remaining = BRIEF_MAX_BYTES;
  let classified = task;
  for (const match of references.matchAll(pattern)) {
    const file = match[1] ?? match[2];
    if (!path.isAbsolute(file) || file.startsWith('//') || file.startsWith('\\\\') || seen.has(file)) continue;
    const lineStart = references.lastIndexOf('\n', match.index) + 1;
    if (!BRIEF_POINTER_RE.test(references.slice(lineStart, match.index))) continue;
    if (NON_BRIEF_FILE_RE.test(path.basename(file))) continue;
    if (seen.size >= BRIEF_MAX_FILES || remaining === 0) {
      skip(file, `limite de ${BRIEF_MAX_FILES} briefs / ${BRIEF_MAX_BYTES / 1024} KiB atingido`);
      break;
    }
    seen.add(file);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(file);
      if (!before.isFile()) continue;
      // realpath: diretório-pai simbólico apontando para fora também fica fora.
      const real = await realpath(file);
      if (!roots.some((root) => isInside(real, root))) {
        skip(file, 'fora da raiz do projeto e de userData/briefs');
        continue;
      }
      if (before.size > remaining) {
        skip(file, `${before.size} bytes acima do teto de ${remaining} bytes`);
        continue;
      }
      // Nonblocking open + fd-bound checks avoid FIFO hangs and replacement races.
      handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > remaining || stat.ino !== before.ino || stat.dev !== before.dev) continue;
      const buffer = Buffer.alloc(remaining + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
        if (length === buffer.length) break;
      }
      if (length > remaining) {
        skip(file, `cresceu acima do teto de ${remaining} bytes durante a leitura`);
        continue;
      }
      remaining -= length;
      let content = buffer.subarray(0, length).toString('utf8');
      if (path.extname(file).toLowerCase() === '.json') {
        try {
          content = JSON.stringify(redactState(JSON.parse(content)));
        } catch {
          // A readable draft still describes the work before it is valid JSON.
        }
      }
      classified += `\n${redactBriefText(content)}`;
    } catch {
      // An unreadable reference must not prevent routing the original task.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return classified;
}

/** O que o agente pediu e o roteamento descartou — vai no recibo. */
export function ignoredRouteChoice(
  args: Record<string, unknown>,
): { adapterId?: string; model?: string; effort?: string } | null {
  const adapterId = nonBlank(args.adapterId);
  const model = nonBlank(args.model);
  const effort = nonBlank(args.effort);
  if (!adapterId && !model && !effort) return null;
  return {
    ...(adapterId ? { adapterId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export interface UseCountPane {
  readonly sessionId: string | null;
  readonly adapterId?: string;
  readonly state: PaneRuntimeState;
}

const INACTIVE: ReadonlySet<PaneRuntimeState> = new Set(['exited', 'parked', 'hibernated']);

/**
 * CLIs já em uso pelo agente pai: a dele e a de cada filho vivo que ele
 * abriu. É "por pai" porque o Main ainda não conhece abas (sub-projeto B).
 */
export function operatorChildUseCounts(
  parentSessionId: string | undefined,
  parentAdapterId: string | undefined,
  panes: readonly UseCountPane[],
  parentOf: (sessionId: string) => string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!parentSessionId) return counts;
  const bump = (adapterId: string) => counts.set(adapterId, (counts.get(adapterId) ?? 0) + 1);
  if (parentAdapterId) bump(parentAdapterId);
  for (const pane of panes) {
    if (!pane.sessionId || !pane.adapterId || INACTIVE.has(pane.state)) continue;
    if (parentOf(pane.sessionId) !== parentSessionId) continue;
    bump(pane.adapterId);
  }
  return counts;
}

export interface MissionUsePane extends UseCountPane {
  readonly paneId?: string;
  readonly missionId?: string;
}

/**
 * CLIs dos panes VIVOS da missão que o registro durável (`mission_panes`) não
 * conhece. Os helpers da missão da aba (0.76.110) nascem sem linha ali e a
 * reserva de rota some ao ser consumida: o roteador via "só o orquestrador em
 * uso" a cada spawn e mandava todos os helpers para a mesma CLI (F-658).
 */
export function liveMissionAdapterIds(
  missionId: string,
  panes: readonly MissionUsePane[],
  recordedPaneIds: ReadonlySet<string>,
): string[] {
  return panes
    .filter(
      (pane) =>
        pane.missionId === missionId &&
        Boolean(pane.adapterId) &&
        !INACTIVE.has(pane.state) &&
        !(pane.paneId && recordedPaneIds.has(pane.paneId)),
    )
    .map((pane) => pane.adapterId!);
}

/**
 * F-985: panes VIVOS da missão nesta CLI — a régua dos assentos Claude
 * (F-235). A composição durável (`mission_panes`) guarda o pane depois que
 * ele fecha; contar a linha do worker que entregou e fechou segurava a conta
 * até o fim da missão e a rota dizia "claude=não instalado". Linha sem paneId
 * conta (sem prova de que fechou); vivos sem linha (F-658) também contam.
 */
export function liveMissionAdapterSeats(
  adapterId: string,
  missionId: string,
  recorded: readonly { readonly adapterId?: string | null; readonly paneId?: string | null }[],
  panes: readonly MissionUsePane[],
): number {
  const live = new Set(
    panes
      .filter((pane) => pane.paneId && !INACTIVE.has(pane.state))
      .map((pane) => pane.paneId!),
  );
  const recordedPaneIds = new Set(
    recorded
      .map((row) => row.paneId)
      .filter((paneId): paneId is string => Boolean(paneId)),
  );
  const recordedLive = recorded.filter(
    (row) => row.adapterId === adapterId && (!row.paneId || live.has(row.paneId)),
  ).length;
  const unrecordedLive = liveMissionAdapterIds(missionId, panes, recordedPaneIds)
    .filter((id) => id === adapterId).length;
  return recordedLive + unrecordedLive;
}

/** Helpers vivos na mesma CLI a partir dos quais o recibo sugere diversificar. */
export const SAME_ADAPTER_DIVERSITY_THRESHOLD = 2;

/**
 * F-672: quem fixa `adapterId` recebe a CLI que pediu — escolha explícita é
 * respeitada —, mas o recibo avisa quando ela já tem helpers vivos na missão.
 * Campo 28/09: depois de uma falha do Codex já corrigida, o orquestrador passou
 * a fixar Claude em todo spawn e o roteamento pelo Jev nunca mais foi usado.
 */
export function sameAdapterDiversityHint(
  adapterId: string | undefined,
  missionId: string | undefined,
  panes: readonly (MissionUsePane & { readonly role?: string })[],
  newPaneId?: string,
): { sameAdapterLive: number; hint: string } | null {
  if (!adapterId || !missionId) return null;
  const live = panes.filter(
    (pane) =>
      pane.missionId === missionId &&
      pane.adapterId === adapterId &&
      pane.role !== 'orchestrator' &&
      !INACTIVE.has(pane.state) &&
      pane.paneId !== newPaneId,
  ).length;
  if (live < SAME_ADAPTER_DIVERSITY_THRESHOLD) return null;
  return {
    sameAdapterLive: live,
    hint:
      `Já há ${live} helpers vivos em ${adapterId} nesta missão. Para distribuir ` +
      'o trabalho entre CLIs, omita adapterId e model no próximo nexus_pane_spawn: ' +
      'o Nexus roteia pela tarefa (Jev) entre as CLIs prontas.',
  };
}

/** CLIs de terminal que não carregam o MCP do Nexus (entrega só pelo fim do PTY). */
export function adapterIdsWithoutNexusMcp<
  T extends { readonly id: string; readonly kind: string },
>(adapters: readonly T[], canUseNexusMcp: (adapter: T) => boolean): string[] {
  return adapters
    .filter((adapter) => adapter.kind === 'cli-pty' && !canUseNexusMcp(adapter))
    .map((adapter) => adapter.id);
}

/**
 * F-802: fora do Autopilot o pty-ipc recusa "cannot enforce native read-only
 * authority" para a CLI que não confina leitura. A rota do helper somente
 * leitura da mão do operador não pode entregar uma CLI que o spawn vai
 * derrubar: o pool fica só com as que confinam. Se NENHUMA instalada confina,
 * o pool não é tocado (o spawn mostra o erro real; ausência de declaração não
 * derruba a rota inteira) — o mesmo contrato do filtro de busca na web (F-771).
 */
export function limitToReadOnlyCapable<
  T extends {
    readonly installed: boolean;
    readonly capabilities?: { readonly readOnlyEnforceable?: boolean };
  },
>(adapters: readonly T[], required: boolean): { adapters: T[]; note: string } {
  const capable = (adapter: T): boolean =>
    adapter.capabilities?.readOnlyEnforceable === true;
  if (!required || !adapters.some((adapter) => adapter.installed && capable(adapter))) {
    return { adapters: [...adapters], note: '' };
  }
  return {
    adapters: adapters.map((adapter) =>
      adapter.installed && !capable(adapter)
        ? { ...adapter, installed: false, unavailableReason: 'não confina leitura (helper somente leitura)' }
        : adapter,
    ),
    note: '; helper somente leitura fora do Autopilot — pool limitado às CLIs que confinam leitura',
  };
}

/**
 * Recibo da proveniência do Jev (confiança por dimensão + o que a regra teria
 * escolhido), copiado do resultado da rota SÓ quando o Jev influenciou e só nos
 * campos conhecidos: ids de CLI/modelo/esforço e números. O texto da tarefa e
 * qualquer outra chave que alguém tenha pendurado no objeto não passam.
 */
export function routeJevReceipt(route: Record<string, unknown> | undefined): {
  confidence?: SpawnRouteConfidence;
  ruleChoice?: SpawnRuleChoiceReceipt;
} {
  const source = route?.classifierSource;
  if (source !== 'jev' && source !== 'mixed') return {};
  const confidence = parseSpawnRouteConfidence(route?.confidence);
  const ruleChoice = parseSpawnRuleChoice(route?.ruleChoice);
  return {
    ...(confidence ? { confidence } : {}),
    ...(ruleChoice ? { ruleChoice } : {}),
  };
}

/** Origem da rota que o renderer exibe (chip + toast). */
export function spawnRouteFrom(
  route: Record<string, unknown> | undefined,
): SpawnRouteInfo | undefined {
  if (!route) return undefined;
  const raw = route.classifierSource;
  const source = raw === 'jev' || raw === 'mixed' ? raw : 'heuristic';
  return {
    source,
    ...(isJevUnavailableReason(route.jevUnavailable)
      ? { jevUnavailable: route.jevUnavailable }
      : {}),
    ...routeJevReceipt(route),
  };
}

export function routeString(
  route: Record<string, unknown> | undefined,
  key: 'adapterId' | 'model' | 'effort',
): string | undefined {
  return nonBlank(route?.[key]);
}

/**
 * O renderer herda a aba do pai pelo PANE id. A sessão do pai
 * (`operatorParentSessionId`) é autoridade do Main e nunca cruza para lá.
 */
export function parentPaneIdFor(
  parentSessionId: string | undefined,
  findPaneId: (sessionId: string) => string | undefined,
): string | undefined {
  return parentSessionId ? findPaneId(parentSessionId) : undefined;
}
