import { decisionResultUsage } from '../decision-models/decision-usage';
/**
 * Sugestão de skill via TypeSafe Jev (cookbook oficial "skill suggestion"):
 * o catálogo das skills bundled é levantado em código (frontmatter dos
 * SKILL.md dos manifests + skills inline geradas pelo skill-mirror) e UMA
 * pergunta `choice` deixa o Jev escolher no máximo UMA skill útil para a
 * tarefa — `none` quando nenhuma for claramente útil. O Jev nunca instala
 * nem executa skill; quem age é o código chamador. FAIL-OPEN: superfície
 * desligada, sem chave, erro ou baixa confiança → null.
 */
import path from 'node:path';
import {
  capText,
  judge,
  type JevAnswer,
  type JevQuestion,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import {
  BUNDLED_MANIFESTS,
  GENERATED_INLINE_SKILL_BODIES,
} from './skill-mirror';
import type { SkillAsset } from './impeccable-manifest';
import { scanSkillsDirectory, type SkillEntry } from '../skills/skills-catalog';
import { tryResolveSubdirUnderRoot } from '../security/scoped-workspace-fs';
import { suggestMissionLaneFromGoal } from '../../shared/mission-intent';
import { BUILTIN_ADAPTERS } from '../../adapters/builtin';
import { adapterSchema } from '../../shared/adapter-types';

/**
 * Piso ÚNICO de confiança para uma sugestão de skill ser aplicada. F-1306:
 * `parseSkillSuggestion` aceitava ≥0.6 enquanto o hook (0.7) e o spawn (0.7)
 * exigiam ≥0.7 — o `nexus_route_task` devolvia uma sugestão que ninguém
 * aplicava (banda morta 0.6–0.69). Uma constante só, importada nos três pontos.
 */
export const SKILL_SUGGESTION_MIN_CONFIDENCE = 0.7;
const SKILL_SUGGESTION_TIMEOUT_MS = 4_000;
const TASK_MAX_CHARS = 1_500;
const DESCRIPTION_MAX_CHARS = 300;
const CRITERIA_SKILLS_MAX = 120;

export interface BundledSkillCatalogEntry {
  name: string;
  description: string;
  pkg: string;
  /**
   * F-753: skill instalada NO PROJETO — caminho do SKILL.md relativo à raiz
   * (`.claude/skills/<nome>/SKILL.md`), que qualquer CLI consegue ler.
   */
  path?: string;
}

/** Pacote das skills que moram no projeto (não vêm com o Nexus). */
export const PROJECT_SKILL_PKG = 'project';

/** Onde o painel Skills e o catálogo do Jev procuram skills do projeto. */
const PROJECT_SKILL_DIRS = ['.claude/skills', '.nexus/skills'] as const;

/**
 * O nome da pasta vira opção do Jev e texto no pedido do agente: só o formato
 * de nome de skill. Uma pasta do repositório com crase ou quebra de linha no
 * nome não escreve no contexto do agente.
 */
const SAFE_PROJECT_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

type ProjectSkillScan = (dir: string) => readonly Pick<SkillEntry, 'name' | 'description'>[];

/**
 * A pasta do painel Skills (`skillsDirs` do product-wave-ipc): resolvida
 * dentro da raiz, então `.claude/skills` ligado para fora do projeto (ex.: a
 * HOME) não entra no catálogo nem sai para o modelo de decisão.
 */
function scanProjectSkillsDir(projectRoot: string, dir: string) {
  const resolved = tryResolveSubdirUnderRoot(projectRoot, dir);
  return resolved ? scanSkillsDirectory(resolved) : [];
}

function unquoteDescription(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim();
}

/**
 * O hook do "+ Pane" pergunta a cada pedido: a pasta é relida no máximo uma
 * vez por minuto por raiz (instalar uma skill nova aparece no minuto seguinte).
 */
const PROJECT_SKILL_CACHE_TTL_MS = 60_000;
const PROJECT_SKILL_CACHE_MAX_ROOTS = 16;
const projectSkillCache = new Map<string, { at: number; catalog: BundledSkillCatalogEntry[] }>();

export function __resetProjectSkillCacheForTests(): void {
  projectSkillCache.clear();
}

/**
 * F-753: as skills que o operador instalou no projeto (o que o painel Skills
 * lista: `.claude/skills` e `.nexus/skills`), pelo mesmo leitor seguro do
 * painel (sem symlink, SKILL.md dentro da raiz). Sem raiz, nada. `scan`
 * injetado (testes) recebe o caminho cru e não passa pelo cache.
 */
export function listProjectSkillCatalog(
  projectRoot: string | undefined,
  scan?: ProjectSkillScan,
  now: number = Date.now(),
): BundledSkillCatalogEntry[] {
  if (!projectRoot) return [];
  const cacheable = scan === undefined;
  const cached = cacheable ? projectSkillCache.get(projectRoot) : undefined;
  if (cached && now - cached.at < PROJECT_SKILL_CACHE_TTL_MS) return cached.catalog;
  const catalog = scanProjectSkillDirs(projectRoot, scan);
  if (cacheable) {
    projectSkillCache.delete(projectRoot);
    projectSkillCache.set(projectRoot, { at: now, catalog });
    if (projectSkillCache.size > PROJECT_SKILL_CACHE_MAX_ROOTS) {
      const oldest = projectSkillCache.keys().next().value;
      if (oldest !== undefined) projectSkillCache.delete(oldest);
    }
  }
  return catalog;
}

function scanProjectSkillDirs(
  projectRoot: string,
  scan: ProjectSkillScan | undefined,
): BundledSkillCatalogEntry[] {
  const catalog: BundledSkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const dir of PROJECT_SKILL_DIRS) {
    let entries: readonly Pick<SkillEntry, 'name' | 'description'>[];
    try {
      entries = scan
        ? scan(path.join(projectRoot, ...dir.split('/')))
        : scanProjectSkillsDir(projectRoot, dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!SAFE_PROJECT_SKILL_NAME.test(entry.name)) continue;
      const key = entry.name.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      catalog.push({
        name: entry.name,
        description: unquoteDescription(entry.description).slice(0, DESCRIPTION_MAX_CHARS),
        pkg: PROJECT_SKILL_PKG,
        path: `${dir}/${entry.name}/SKILL.md`,
      });
    }
  }
  return catalog;
}

/** Lê `name:`/`description:` do frontmatter YAML de um SKILL.md. */
function parseSkillFrontmatter(
  content: string,
): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let value = kv[2];
    if (/^[>|][-+]?$/.test(value)) {
      // YAML block scalar: folded (`>`) or literal (`|`) — the value lives
      // in the indented continuation lines until the first non-indented key.
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === '') {
          if (parts.length === 0) continue;
          break;
        }
        if (!/^[ \t]/.test(next)) break;
        parts.push(next.trim());
      }
      value = parts.join(' ');
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    if (!value) continue;
    if (kv[1] === 'name' && name === undefined) name = value;
    if (kv[1] === 'description' && description === undefined) {
      description = value;
    }
  }
  return { name, description };
}

function pushCatalogEntry(
  catalog: BundledSkillCatalogEntry[],
  seen: Set<string>,
  pkg: string,
  content: string,
): void {
  const meta = parseSkillFrontmatter(content);
  const name = meta.name?.trim();
  if (!name) return;
  const key = name.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  catalog.push({
    name,
    description: (meta.description ?? '').slice(0, DESCRIPTION_MAX_CHARS),
    pkg,
  });
}

/**
 * Catálogo estável das skills bundled: um item por SKILL.md com `name` no
 * frontmatter (inclui sub-skills tipo `superpowers/<sub>/SKILL.md`),
 * dedup por nome, na ordem dos manifests + skills inline geradas.
 */
export function listBundledSkillCatalog(
  manifests: Record<string, Record<string, SkillAsset>> = BUNDLED_MANIFESTS,
  inline: Record<string, string> = GENERATED_INLINE_SKILL_BODIES,
): BundledSkillCatalogEntry[] {
  const catalog: BundledSkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const [pkg, manifest] of Object.entries(manifests)) {
    for (const [relPath, asset] of Object.entries(manifest)) {
      if (!relPath.endsWith('SKILL.md')) continue;
      const content =
        asset.encoding === 'base64'
          ? Buffer.from(asset.content, 'base64').toString('utf8')
          : asset.content;
      pushCatalogEntry(catalog, seen, pkg, content);
    }
  }
  for (const [name, body] of Object.entries(inline)) {
    pushCatalogEntry(catalog, seen, name, body);
  }
  return catalog;
}

export interface SkillSuggestionDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  record?: typeof recordJevDecision;
  /** Leitor das skills do projeto (testes); default = o do painel Skills. */
  scanProjectSkills?: ProjectSkillScan;
}

export interface SkillSuggestionPick {
  name: string;
  pkg: string;
  confidence: number;
  /** Skill do projeto: SKILL.md relativo à raiz (F-753). */
  path?: string;
}

/**
 * Catálogo das skills bundled filtrado pelos grants do chamador.
 * Grants são por PACOTE no skill-mirror (ex.: `superpowers`) enquanto as
 * entradas do catálogo são sub-skills (`brainstorming`): vale pkg OU name.
 * `null` = sem restrição (catálogo inteiro).
 */
export function allowedSkillCatalog(
  allowedSkills: string[] | null,
  manifests?: Record<string, Record<string, SkillAsset>>,
): BundledSkillCatalogEntry[] {
  return filterByGrants(listBundledSkillCatalog(manifests), allowedSkills);
}

/**
 * F-753: as skills instaladas no projeto, filtradas pelos mesmos grants (squad
 * governado só recebe a que eles nomeiam). Vão numa pergunta PRÓPRIA no mesmo
 * lote do Jev: misturadas às bundled (74 opções) a confiança se espalhava —
 * medido em 60 tarefas reais do hipergo, 8 escolhas ≥ 0,7 contra 12 só com as
 * bundled; em duas perguntas, 21 (11 bundled + 10 do projeto).
 */
export function allowedProjectSkillCatalog(
  allowedSkills: string[] | null,
  projectRoot: string | undefined,
  scan?: ProjectSkillScan,
): BundledSkillCatalogEntry[] {
  return filterByGrants(listProjectSkillCatalog(projectRoot, scan), allowedSkills);
}

function filterByGrants(
  catalog: readonly BundledSkillCatalogEntry[],
  allowedSkills: string[] | null,
): BundledSkillCatalogEntry[] {
  const allowed =
    allowedSkills === null
      ? null
      : new Set(allowedSkills.map((s) => s.trim().toLocaleLowerCase()));
  return catalog.filter(
    (entry) =>
      !allowed ||
      allowed.has(entry.name.toLocaleLowerCase()) ||
      allowed.has(entry.pkg.toLocaleLowerCase()),
  );
}

/** Chave da pergunta das skills do projeto no lote do Jev. */
export const PROJECT_SKILL_QUESTION = 'projectSkill';

/**
 * F-772 (G7a): skills de PAPEL do squad. Workers (escrevem código) usam
 * builder/pilot/debugging; panes read-only (lane consult) investigam e
 * relatam — scout/conveyor. Antes o catálogo inteiro ia para toda tarefa e
 * o Jev sugeria oc-scout para workers (20/108 sugestões da missão, até 0,95)
 * e systematic-debugging para sessões que nem a tinham.
 */
const WRITER_ROLE_SKILLS = new Set([
  'oc-pilot',
  'oc-builder',
  'systematic-debugging',
]);
const SCOUT_ROLE_SKILLS = new Set(['oc-scout', 'oc-conveyor']);

/**
 * Filtra o catálogo apresentado ao Jev pelo papel que a tarefa pede. Lane
 * `consult` (read-only) perde as skills de escrita; todo o resto perde as de
 * investigação. Skills de projeto nunca passam por aqui — nome livre, o
 * operador escolheu instalar.
 */
export function skillCatalogForTaskRole(
  taskText: string,
  catalog: BundledSkillCatalogEntry[],
): BundledSkillCatalogEntry[] {
  const excluded =
    suggestMissionLaneFromGoal(taskText) === 'consult'
      ? WRITER_ROLE_SKILLS
      : SCOUT_ROLE_SKILLS;
  return catalog.filter((entry) => !excluded.has(entry.name.toLowerCase()));
}

/** CLIs com entrega própria de skills (skill-mirror ou sessão governada). */
const GOVERNED_SKILL_SURFACE_ADAPTERS = new Set([
  'codex',
  'agy',
  'kimi',
  'grok',
  'opencode',
  'mimo-code',
  'qwen',
]);

const BUILTIN_ADAPTER_IDS = new Set(
  BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw).id),
);

const CLAUDE_LAYOUT_SURFACE_ADAPTERS = new Set(
  BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw))
    .filter((adapter) => adapter.kind === 'cli-pty' && adapter.bin === 'claude')
    .map((adapter) => adapter.id),
);

/**
 * F-772 (G7a): a dica "leia a SKILL.md" só vale quando a CLI roteada tem
 * superfície de skills — a família do binário `claude` (HOME `.claude/skills`
 * real ou efêmero) e os CLIs com entrega própria. Sem superfície (muse,
 * minimax-code, aider, devin, openclaude…), sugerir uma skill mandaria o
 * worker ler um arquivo que não existe na sessão dele. Adapter de usuário
 * (fora do catálogo bundled) mantém a sugestão: fail-open, o gate de grants
 * no spawn continua decidindo o que entra.
 */
export function cliSupportsSkillSurface(adapterId: string): boolean {
  if (
    GOVERNED_SKILL_SURFACE_ADAPTERS.has(adapterId) ||
    CLAUDE_LAYOUT_SURFACE_ADAPTERS.has(adapterId)
  ) {
    return true;
  }
  return !BUILTIN_ADAPTER_IDS.has(adapterId);
}

/**
 * As duas perguntas de skill do lote: bundled (`skill`) e do projeto
 * (`projectSkill`), cada uma só quando o seu catálogo não está vazio.
 */
export function buildSkillSuggestionQuestions(
  bundled: BundledSkillCatalogEntry[],
  project: BundledSkillCatalogEntry[],
): Record<string, JevQuestion> {
  return {
    ...(bundled.length > 0 ? { skill: buildSkillSuggestionQuestion(bundled) } : {}),
    ...(project.length > 0
      ? { [PROJECT_SKILL_QUESTION]: buildSkillSuggestionQuestion(project) }
      : {}),
  };
}

/**
 * A skill do lote: a escolha mais confiante entre as duas perguntas (empate
 * fica com a do projeto, que o operador instalou para ESTE projeto).
 */
export function parseSkillSuggestions(
  answers: Record<string, JevAnswer>,
  bundled: BundledSkillCatalogEntry[],
  project: BundledSkillCatalogEntry[],
): SkillSuggestionPick | null {
  const fromBundled = bundled.length > 0 ? parseSkillSuggestion(answers, bundled) : null;
  const fromProject =
    project.length > 0 ? parseSkillSuggestion(answers, project, PROJECT_SKILL_QUESTION) : null;
  if (fromProject && (!fromBundled || fromProject.confidence >= fromBundled.confidence)) {
    return fromProject;
  }
  return fromBundled;
}

/**
 * Pergunta `choice` da skill (builder reutilizável): mesmos critérios do
 * caminho standalone — cap de CRITERIA_SKILLS_MAX entradas + opção `none`.
 */
export function buildSkillSuggestionQuestion(
  catalog: BundledSkillCatalogEntry[],
): JevQuestion {
  const criteria: Record<string, string | null> = {};
  for (const entry of catalog.slice(0, CRITERIA_SKILLS_MAX)) {
    criteria[entry.name] = entry.description || entry.name;
  }
  criteria['none'] = 'nenhuma skill é claramente útil';
  return {
    type: 'choice',
    instructions:
      'Qual skill instalada ajuda mais nesta tarefa? Escolha none se ' +
      'nenhuma for claramente útil.',
    criteria,
  };
}

/**
 * Parser da resposta `skill` (fail-open): `none`, confiança baixa ou escolha
 * fora do catálogo elegível → null. Devolve o pick com o pkg do catálogo.
 */
export function parseSkillSuggestion(
  answers: Record<string, JevAnswer>,
  catalog: BundledSkillCatalogEntry[],
  questionKey = 'skill',
): SkillSuggestionPick | null {
  const answer = answers[questionKey];
  if (answer?.type !== 'choice') return null;
  const eligible = catalog.slice(0, CRITERIA_SKILLS_MAX);
  if (
    answer.choice === 'none' ||
    answer.confidence < SKILL_SUGGESTION_MIN_CONFIDENCE ||
    !eligible.some((entry) => entry.name === answer.choice)
  ) {
    return null;
  }
  const picked = eligible.find((entry) => entry.name === answer.choice);
  return {
    name: answer.choice,
    pkg: picked?.pkg ?? '',
    confidence: answer.confidence,
    ...(picked?.path ? { path: picked.path } : {}),
  };
}

export async function suggestSkillForTask(
  task: string,
  opts: {
    allowedSkills: string[] | null;
    /** Raiz do projeto: as skills instaladas nele entram no catálogo (F-753). */
    projectRoot?: string;
    /**
     * F-772 (G7a): CLI de destino, quando conhecida. Sem superfície de skills
     * (muse, minimax-code…) a sugestão nem é perguntada — mandaria o pane ler
     * uma SKILL.md que a sessão dele não recebe.
     */
    adapterId?: string;
    sessionId?: string;
    missionId?: string;
    /**
     * Teto por tentativa e abort externo. Quem espera a resposta num hook
     * passa o teto total dele: sem o `signal`, o retry do judge dobrava a espera.
     */
    timeoutMs?: number;
    signal?: AbortSignal;
    deps?: SkillSuggestionDeps;
  },
): Promise<SkillSuggestionPick | null> {
  const enabled = opts.deps?.enabled ?? (() => isJevSurfaceEnabled('taskRouting'));
  const hasKey = opts.deps?.hasKey ?? (() => hasDecisionCredential('taskRouting'));
  const judgeFn = opts.deps?.judge ?? judge;
  const record = opts.deps?.record ?? recordJevDecision;
  if (!task.trim() || !enabled() || !hasKey()) return null;

  // F-1307 (refina F-772 G7a): pane sem superfície de skill bundled (muse,
  // minimax-code…) não lê uma SKILL.md da HOME, mas a skill de PROJETO (um
  // SKILL.md dentro do workspace, legível por qualquer CLI) continua valendo.
  // Só o catálogo bundled esvazia; o de projeto segue para o Jev.
  const bundledSurface =
    opts.adapterId === undefined || cliSupportsSkillSurface(opts.adapterId);

  // F-772 (G7a): papel da tarefa restringe o catálogo bundled antes do Jev
  // escolher — scout/conveyor fora de workers, builder/debugging fora de
  // panes read-only.
  const catalog = bundledSurface
    ? skillCatalogForTaskRole(task, allowedSkillCatalog(opts.allowedSkills))
    : [];
  const projectCatalog = allowedProjectSkillCatalog(
    opts.allowedSkills,
    opts.projectRoot,
    opts.deps?.scanProjectSkills,
  );
  const questions = buildSkillSuggestionQuestions(catalog, projectCatalog);
  if (Object.keys(questions).length === 0) return null;

  try {
    const result = await judgeFn({
      state: { task: capText(task, TASK_MAX_CHARS, { keepEnds: true }) },
      questions,
      timeoutMs: opts.timeoutMs ?? SKILL_SUGGESTION_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
      surface: 'taskRouting',
      sessionId: opts.sessionId,
      missionId: opts.missionId,
    });
    if (!result) return null;
    const picked = parseSkillSuggestions(result.answers, catalog, projectCatalog);
    if (!picked) return null;
    record({
      surface: 'taskRouting',
      sessionId: opts.sessionId,
      missionId: opts.missionId,
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: `skill:${picked.name}`,
      ...decisionResultUsage(result),
    });
    return picked;
  } catch {
    return null;
  }
}
