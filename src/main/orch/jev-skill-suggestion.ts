/**
 * Sugestão de skill via TypeSafe Jev (cookbook oficial "skill suggestion"):
 * o catálogo das skills bundled é levantado em código (frontmatter dos
 * SKILL.md dos manifests + skills inline geradas pelo skill-mirror) e UMA
 * pergunta `choice` deixa o Jev escolher no máximo UMA skill útil para a
 * tarefa — `none` quando nenhuma for claramente útil. O Jev nunca instala
 * nem executa skill; quem age é o código chamador. FAIL-OPEN: superfície
 * desligada, sem chave, erro ou baixa confiança → null.
 */
import {
  capText,
  judge,
  USD_PER_INPUT_TOKEN,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasJevCredential } from '../jev/jev-secrets';
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

export const SKILL_SUGGESTION_MIN_CONFIDENCE = 0.6;
const SKILL_SUGGESTION_TIMEOUT_MS = 4_000;
const TASK_MAX_CHARS = 1_500;
const DESCRIPTION_MAX_CHARS = 300;
const CRITERIA_SKILLS_MAX = 120;

export interface BundledSkillCatalogEntry {
  name: string;
  description: string;
  pkg: string;
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
}

export async function suggestSkillForTask(
  task: string,
  opts: {
    allowedSkills: string[] | null;
    sessionId?: string;
    missionId?: string;
    deps?: SkillSuggestionDeps;
  },
): Promise<{ name: string; confidence: number } | null> {
  const enabled = opts.deps?.enabled ?? (() => isJevSurfaceEnabled('taskRouting'));
  const hasKey = opts.deps?.hasKey ?? hasJevCredential;
  const judgeFn = opts.deps?.judge ?? judge;
  const record = opts.deps?.record ?? recordJevDecision;
  if (!task.trim() || !enabled() || !hasKey()) return null;

  const allowed =
    opts.allowedSkills === null
      ? null
      : new Set(opts.allowedSkills.map((s) => s.trim().toLocaleLowerCase()));
  const catalog = listBundledSkillCatalog().filter(
    (entry) => !allowed || allowed.has(entry.name.toLocaleLowerCase()),
  );
  if (catalog.length === 0) return null;

  const criteria: Record<string, string | null> = {};
  for (const entry of catalog.slice(0, CRITERIA_SKILLS_MAX)) {
    criteria[entry.name] = entry.description || entry.name;
  }
  criteria['none'] = 'nenhuma skill é claramente útil';

  try {
    const result = await judgeFn({
      state: { task: capText(task, TASK_MAX_CHARS) },
      questions: {
        skill: {
          type: 'choice',
          instructions:
            'Qual skill instalada ajuda mais nesta tarefa? Escolha none se ' +
            'nenhuma for claramente útil.',
          criteria,
        },
      },
      timeoutMs: SKILL_SUGGESTION_TIMEOUT_MS,
      surface: 'taskRouting',
      sessionId: opts.sessionId,
      missionId: opts.missionId,
    });
    if (!result) return null;
    const answer = result.answers['skill'];
    if (
      answer?.type !== 'choice' ||
      answer.choice === 'none' ||
      answer.confidence < SKILL_SUGGESTION_MIN_CONFIDENCE ||
      !(answer.choice in criteria)
    ) {
      return null;
    }
    record({
      surface: 'taskRouting',
      sessionId: opts.sessionId,
      missionId: opts.missionId,
      model: result.model,
      questions: ['skill'],
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: `skill:${answer.choice}`,
      inputTokens: result.usage.input_tokens,
      usd: result.usage.input_tokens * USD_PER_INPUT_TOKEN,
    });
    return { name: answer.choice, confidence: answer.confidence };
  } catch {
    return null;
  }
}
