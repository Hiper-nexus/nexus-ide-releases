/**
 * F-757: o modelo de decisão (Jev, ou Clef em Automático/Somente Clef)
 * recomenda agentes e instruções do Marketplace para o projeto aberto.
 *
 * O código levanta as ÁREAS do projeto pelos arquivos (dependências dos
 * package.json do workspace, go.mod/go.work, Dockerfile, *.tf…) e, para cada
 * área, os itens do catálogo cujo nome casa com ela. O modelo só escolhe: no
 * máximo um agente e uma instrução por área (`choice` com `none`), aceitos com
 * confiança ≥ 0,7. Nada é baixado nem instalado aqui; instalar continua com os
 * dois diálogos do Marketplace.
 *
 * Egress: os rótulos das áreas ("React", "Go") e nome + categoria dos itens
 * candidatos. Nunca caminho, nome do projeto ou conteúdo de arquivo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CatalogEntry, CatalogIndex, CatalogKind, InstalledItem } from './catalog-contract';
import { judge, type JevAnswer, type JevQuestion } from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import { decisionResultUsage } from '../decision-models/decision-usage';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
} from '../jev/jev-decision-log';
import type {
  CatalogProjectArea,
  CatalogRecommendation,
  CatalogRecommendationsResult,
} from '../../shared/surface-payload-types';

export const CATALOG_PICK_MIN_CONFIDENCE = 0.7;
const MAX_OPTIONS_PER_QUESTION = 12;
const CATALOG_PICK_TIMEOUT_MS = 20_000;
const RECOMMENDATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WALK_DEPTH = 3;
const MAX_WALK_ENTRIES = 4_000;
const MAX_MANIFESTS = 24;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Pastas que não dizem nada da stack (e custam caro de percorrer). */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  '.nexus',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
]);

interface AreaRule {
  id: string;
  label: string;
  /** Nome exato de dependência em algum package.json do workspace. */
  deps?: readonly string[];
  /** Arquivo ou pasta (caminho relativo terminando nele) em até 3 níveis. */
  files?: readonly string[];
  /** Vizinho (na mesma pasta) que tira o arquivo de `files` da prova. */
  notBeside?: readonly string[];
  /** Palavra em requirements.txt / pyproject.toml. */
  pyDeps?: readonly string[];
  /** Extensão de arquivo em até 3 níveis. */
  ext?: string;
  /** Pedaço do nome do item do catálogo (separado por - _ .). */
  tokens: readonly string[];
  /** Começo do nome do item (ex.: `api-`). */
  prefixes?: readonly string[];
  /** Pedaço que tira o item da área (ex.: React Native fora de React web). */
  excludes?: readonly string[];
}

/** A ordem é a da tela. Regra conhecida fica em código; o modelo só escolhe. */
export const CATALOG_AREA_RULES: readonly AreaRule[] = [
  { id: 'react', label: 'React', deps: ['react'], tokens: ['react'], excludes: ['native'] },
  { id: 'nextjs', label: 'Next.js', deps: ['next'], tokens: ['nextjs', 'next'] },
  { id: 'vue', label: 'Vue', deps: ['vue', 'nuxt'], tokens: ['vue', 'nuxt'] },
  { id: 'angular', label: 'Angular', deps: ['@angular/core'], tokens: ['angular'] },
  { id: 'svelte', label: 'Svelte', deps: ['svelte', '@sveltejs/kit'], tokens: ['svelte', 'sveltekit'] },
  {
    id: 'tailwind',
    label: 'Tailwind CSS',
    deps: ['tailwindcss', '@tailwindcss/vite', '@tailwindcss/postcss'],
    tokens: ['tailwind'],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    deps: ['typescript'],
    files: ['tsconfig.json'],
    tokens: ['typescript'],
  },
  {
    id: 'node-backend',
    label: 'Backend Node',
    deps: ['express', 'fastify', 'koa', 'hono', '@nestjs/core'],
    tokens: ['express', 'nestjs', 'fastify', 'nodejs', 'node'],
  },
  { id: 'electron', label: 'Electron', deps: ['electron'], tokens: ['electron'] },
  {
    id: 'mobile',
    label: 'App mobile',
    deps: ['react-native', 'expo'],
    files: ['pubspec.yaml'],
    tokens: ['mobile', 'expo', 'flutter', 'ios', 'android'],
    prefixes: ['react-native'],
  },
  {
    id: 'supabase',
    label: 'Supabase',
    deps: ['@supabase/supabase-js', '@supabase/ssr'],
    files: ['supabase/config.toml'],
    tokens: ['supabase'],
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    deps: ['pg', 'postgres', '@neondatabase/serverless'],
    tokens: ['postgres', 'postgresql'],
  },
  {
    id: 'prisma',
    label: 'Prisma',
    deps: ['prisma', '@prisma/client'],
    files: ['prisma/schema.prisma'],
    tokens: ['prisma'],
  },
  { id: 'mongodb', label: 'MongoDB', deps: ['mongodb', 'mongoose'], tokens: ['mongodb', 'mongo'] },
  { id: 'redis', label: 'Redis', deps: ['redis', 'ioredis'], tokens: ['redis'] },
  {
    id: 'graphql',
    label: 'GraphQL',
    deps: ['graphql', '@apollo/server', '@apollo/client'],
    tokens: ['graphql'],
  },
  {
    id: 'stripe',
    label: 'Pagamentos (Stripe)',
    deps: ['stripe', '@stripe/stripe-js'],
    tokens: ['stripe', 'payment', 'payments'],
  },
  { id: 'firebase', label: 'Firebase', deps: ['firebase', 'firebase-admin'], tokens: ['firebase'] },
  {
    id: 'llm',
    label: 'App com LLM',
    deps: ['openai', '@anthropic-ai/sdk', 'langchain', '@langchain/core', 'ai', '@google/genai'],
    tokens: ['llm', 'rag', 'langchain', 'prompt'],
  },
  {
    id: 'openapi',
    label: 'API com OpenAPI',
    deps: ['@redocly/cli', 'openapi-typescript', 'swagger-ui-express', '@apidevtools/swagger-parser'],
    files: ['openapi.yaml', 'openapi.yml', 'openapi.json'],
    tokens: ['openapi', 'swagger'],
    prefixes: ['api-'],
  },
  {
    id: 'e2e',
    label: 'Testes end-to-end',
    deps: ['@playwright/test', 'playwright', 'cypress'],
    tokens: ['playwright', 'cypress', 'e2e'],
  },
  {
    id: 'testing',
    label: 'Testes',
    deps: ['vitest', 'jest', 'mocha', '@testing-library/react'],
    tokens: ['test', 'testing', 'tdd'],
  },
  {
    id: 'python',
    label: 'Python',
    files: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    tokens: ['python'],
  },
  { id: 'django', label: 'Django', pyDeps: ['django'], tokens: ['django'] },
  { id: 'fastapi', label: 'FastAPI', pyDeps: ['fastapi'], tokens: ['fastapi'] },
  { id: 'flask', label: 'Flask', pyDeps: ['flask'], tokens: ['flask'] },
  { id: 'go', label: 'Go', files: ['go.mod', 'go.work'], tokens: ['go', 'golang'] },
  { id: 'rust', label: 'Rust', files: ['Cargo.toml'], tokens: ['rust'] },
  {
    id: 'java',
    label: 'Java',
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    tokens: ['java', 'spring', 'kotlin'],
  },
  { id: 'php', label: 'PHP', files: ['composer.json'], tokens: ['php', 'laravel'] },
  {
    id: 'ruby',
    label: 'Ruby',
    files: ['Gemfile'],
    // App mobile tem Gemfile só para o fastlane/CocoaPods: não é projeto Ruby.
    notBeside: ['fastlane', 'app.json', 'ios'],
    tokens: ['ruby', 'rails'],
  },
  {
    id: 'docker',
    label: 'Docker',
    files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
    tokens: ['docker', 'container', 'containers'],
  },
  {
    id: 'kubernetes',
    label: 'Kubernetes',
    files: ['Chart.yaml', 'k8s', 'helm'],
    tokens: ['kubernetes', 'k8s', 'helm'],
  },
  { id: 'terraform', label: 'Infra como código', ext: '.tf', tokens: ['terraform', 'opentofu', 'iac'] },
  {
    id: 'github-actions',
    label: 'GitHub Actions',
    files: ['.github/workflows'],
    tokens: ['github', 'actions', 'cicd'],
  },
];

/** Caminhos relativos (com `/`) de até 3 segmentos, sem seguir link. */
export interface ProjectInventory {
  files: string[];
  dirs: string[];
}

export async function inventoryProject(root: string): Promise<ProjectInventory> {
  const files: string[] = [];
  const dirs: string[] = [];
  // `depth` = segmentos do caminho da pasta; os filhos dela têm depth + 1.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: '', depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_WALK_ENTRIES) {
    const current = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) break;
      // Link pode sair do projeto: não é stack deste projeto.
      if (entry.isSymbolicLink()) continue;
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        dirs.push(rel);
        if (current.depth + 1 < MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(current.abs, entry.name), rel, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  return { files, dirs };
}

const lastSegments = (rel: string, count: number) => rel.split('/').slice(-count).join('/');

/**
 * O primeiro arquivo/pasta do inventário que termina em `wanted` (que pode ter
 * `/`) e não tem nenhum dos `notBeside` na mesma pasta.
 */
function findByName(
  inventory: ProjectInventory,
  paths: readonly string[],
  wanted: string,
  notBeside: readonly string[] = [],
): string | undefined {
  const segments = wanted.split('/').length;
  return paths.find((rel) => {
    if (lastSegments(rel, segments) !== wanted) return false;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return !notBeside.some((sibling) => {
      const beside = dir ? `${dir}/${sibling}` : sibling;
      return inventory.files.includes(beside) || inventory.dirs.includes(beside);
    });
  });
}

async function readBounded(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Dependências por package.json do inventário (até 24 manifestos). */
async function packageDependencies(
  root: string,
  inventory: ProjectInventory,
): Promise<Array<{ rel: string; deps: Set<string> }>> {
  const manifests = inventory.files
    .filter((rel) => rel === 'package.json' || rel.endsWith('/package.json'))
    .slice(0, MAX_MANIFESTS);
  const out: Array<{ rel: string; deps: Set<string> }> = [];
  for (const rel of manifests) {
    const text = await readBounded(path.join(root, ...rel.split('/')));
    if (!text) continue;
    try {
      const pkg = JSON.parse(text) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        peerDependencies?: Record<string, unknown>;
      };
      const deps = new Set(
        [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap((group) =>
          group && typeof group === 'object' ? Object.keys(group) : [],
        ),
      );
      out.push({ rel, deps });
    } catch {
      // package.json inválido não derruba a recomendação.
    }
  }
  return out;
}

/** Palavras dos manifestos Python (só para casar `django`, `fastapi`, `flask`). */
async function pythonWords(
  root: string,
  inventory: ProjectInventory,
): Promise<{ rel: string; words: Set<string> } | null> {
  const rel = inventory.files.find((file) =>
    /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml)$/.test(file),
  );
  if (!rel) return null;
  const text = await readBounded(path.join(root, ...rel.split('/')));
  if (!text) return null;
  return { rel, words: new Set(text.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean)) };
}

/**
 * As áreas do projeto, cada uma com o arquivo que a provou. Só arquivo do
 * próprio projeto conta (sem link, sem node_modules).
 */
export async function detectCatalogAreas(root: string): Promise<CatalogProjectArea[]> {
  const inventory = await inventoryProject(root);
  const manifests = await packageDependencies(root, inventory);
  const python = await pythonWords(root, inventory);
  const areas: CatalogProjectArea[] = [];
  for (const rule of CATALOG_AREA_RULES) {
    let evidence: string | undefined;
    if (rule.deps) {
      evidence = manifests.find((manifest) => rule.deps!.some((dep) => manifest.deps.has(dep)))?.rel;
    }
    if (!evidence && rule.files) {
      for (const wanted of rule.files) {
        evidence =
          findByName(inventory, inventory.files, wanted, rule.notBeside) ??
          findByName(inventory, inventory.dirs, wanted, rule.notBeside);
        if (evidence) break;
      }
    }
    if (!evidence && rule.pyDeps && python && rule.pyDeps.some((word) => python.words.has(word))) {
      evidence = python.rel;
    }
    if (!evidence && rule.ext) {
      evidence = inventory.files.find((rel) => rel.endsWith(rule.ext!));
    }
    if (evidence) areas.push({ id: rule.id, label: rule.label, evidence });
  }
  return areas;
}

const nameTokens = (name: string) => name.toLowerCase().split(/[-_.\s]+/).filter(Boolean);

/**
 * Os itens de um tipo que casam com a área, fora os já instalados. Primeiro
 * os que COMEÇAM pela área (`react-…` antes de `expert-react-…`), depois os
 * de nome mais curto; no máximo 12 viram opção.
 */
export function areaCandidates(
  rule: Pick<AreaRule, 'tokens' | 'prefixes' | 'excludes'>,
  entries: readonly CatalogEntry[],
  excluded: ReadonlySet<string>,
): CatalogEntry[] {
  const ranked: Array<{ entry: CatalogEntry; lead: number; size: number; order: number }> = [];
  const seen = new Set<string>();
  entries.forEach((entry, order) => {
    const name = entry.name.toLowerCase();
    if (seen.has(name) || excluded.has(`${entry.kind}:${name}`)) return;
    const tokens = nameTokens(name);
    if (rule.excludes?.some((token) => tokens.includes(token))) return;
    const tokenAt = tokens.findIndex((token) => rule.tokens.includes(token));
    const prefixed = rule.prefixes?.some((prefix) => name.startsWith(prefix)) ?? false;
    if (tokenAt < 0 && !prefixed) return;
    seen.add(name);
    ranked.push({ entry, lead: prefixed || tokenAt === 0 ? 0 : 1, size: tokens.length, order });
  });
  ranked.sort((a, b) => a.lead - b.lead || a.size - b.size || a.order - b.order);
  return ranked.slice(0, MAX_OPTIONS_PER_QUESTION).map((item) => item.entry);
}

const KIND_NOUN: Record<CatalogKind, string> = { agent: 'agente', skill: 'instrução (skill)' };

export function catalogQuestionKey(areaId: string, kind: CatalogKind): string {
  return `${areaId.replace(/[^a-z0-9]/g, '_')}_${kind}`;
}

/** Opções por posição (`o1…o12`): o nome do item só aparece no critério. */
export function buildCatalogPickQuestion(
  area: Pick<CatalogProjectArea, 'label'>,
  kind: CatalogKind,
  options: readonly CatalogEntry[],
): JevQuestion {
  const criteria: Record<string, string> = {};
  options.forEach((entry, index) => {
    criteria[`o${index + 1}`] = `${entry.name} (${KIND_NOUN[kind]}, categoria ${entry.category})`;
  });
  criteria.none = 'nenhum é claramente útil para esta parte do projeto';
  return {
    type: 'choice',
    instructions:
      `O estado traz a stack do projeto. Para trabalhar com ${area.label} neste projeto, ` +
      `qual ${KIND_NOUN[kind]} do catálogo mais ajudaria? Escolha none se nenhum for ` +
      'claramente útil.',
    criteria,
  };
}

/** A escolha da pergunta, ou null (`none`, fora das opções, abaixo de 0,7). */
export function parseCatalogPick(
  answer: JevAnswer | undefined,
  options: readonly CatalogEntry[],
): { entry: CatalogEntry; confidence: number } | null {
  if (answer?.type !== 'choice') return null;
  const match = /^o(\d{1,2})$/.exec(answer.choice);
  const entry = match ? options[Number(match[1]) - 1] : undefined;
  if (!entry || !Number.isFinite(answer.confidence)) return null;
  if (answer.confidence < CATALOG_PICK_MIN_CONFIDENCE) return null;
  return { entry, confidence: answer.confidence };
}

export interface CatalogRecommendDeps {
  judge?: typeof judge;
  enabled?: () => boolean;
  hasKey?: () => boolean;
  record?: typeof recordJevDecision;
  detectAreas?: (root: string) => Promise<CatalogProjectArea[]>;
  now?: () => number;
}

const recommendationCache = new Map<string, { at: number; result: CatalogRecommendationsResult }>();
const recommendationFlights = new Map<string, Promise<CatalogRecommendationsResult>>();

export function __resetCatalogRecommendationsForTests(): void {
  recommendationCache.clear();
  recommendationFlights.clear();
}

/**
 * As recomendações do projeto. Nunca lança: sem superfície, sem credencial,
 * sem área ou sem resposta voltam como motivo categórico para a tela.
 */
export async function recommendCatalogItems(input: {
  root: string;
  index: Pick<CatalogIndex, 'agents' | 'skills' | 'provenance'>;
  installed: readonly Pick<InstalledItem, 'kind' | 'name'>[];
  /** Skills que já vêm com o Nexus ou moram no projeto (mesmo nome = já tem). */
  knownSkillNames?: readonly string[];
  refresh?: boolean;
  deps?: CatalogRecommendDeps;
}): Promise<CatalogRecommendationsResult> {
  const deps = input.deps ?? {};
  try {
    if (!(deps.enabled ?? (() => isJevSurfaceEnabled('catalogPick')))()) {
      return { ok: false, reason: 'disabled' };
    }
    if (!(deps.hasKey ?? (() => hasDecisionCredential('catalogPick')))()) {
      return { ok: false, reason: 'no-credential' };
    }
    const areas = await (deps.detectAreas ?? detectCatalogAreas)(input.root);
    if (areas.length === 0) return { ok: false, reason: 'no-areas', areas: [] };

    const excluded = new Set<string>([
      ...input.installed.map((item) => `${item.kind}:${item.name.toLowerCase()}`),
      ...(input.knownSkillNames ?? []).map((name) => `skill:${name.toLowerCase()}`),
    ]);
    const questions: Record<string, JevQuestion> = {};
    const slots: Array<{ key: string; area: CatalogProjectArea; options: CatalogEntry[] }> = [];
    for (const area of areas) {
      const rule = CATALOG_AREA_RULES.find((candidate) => candidate.id === area.id);
      if (!rule) continue;
      for (const kind of ['agent', 'skill'] as const) {
        const options = areaCandidates(rule, kind === 'agent' ? input.index.agents : input.index.skills, excluded);
        if (options.length === 0) continue;
        const key = catalogQuestionKey(area.id, kind);
        questions[key] = buildCatalogPickQuestion(area, kind, options);
        slots.push({ key, area, options });
      }
    }
    const now = (deps.now ?? Date.now)();
    if (slots.length === 0) return { ok: true, areas, recommendations: [], decidedAt: now };

    const cacheKey = JSON.stringify([
      input.root,
      input.index.provenance?.commitSha ?? '',
      slots.map((slot) => [slot.key, slot.options.map((entry) => entry.slug)]),
    ]);
    const cached = recommendationCache.get(cacheKey);
    if (!input.refresh && cached && now - cached.at < RECOMMENDATION_TTL_MS) return cached.result;
    const inFlight = recommendationFlights.get(cacheKey);
    if (inFlight) return inFlight;

    const flight = (async (): Promise<CatalogRecommendationsResult> => {
      const outcome = await (deps.judge ?? judge)({
        state: { stack: areas.map((area) => area.label) },
        questions,
        timeoutMs: CATALOG_PICK_TIMEOUT_MS,
        surface: 'catalogPick',
      });
      if (!outcome) return { ok: false, reason: 'no-answer', areas };

      const merged = new Map<string, CatalogRecommendation>();
      for (const slot of slots) {
        const pick = parseCatalogPick(outcome.answers[slot.key], slot.options);
        if (!pick) continue;
        const id = `${pick.entry.kind}:${pick.entry.name.toLowerCase()}`;
        const confidence = Math.round(pick.confidence * 100) / 100;
        const existing = merged.get(id);
        if (existing) {
          if (!existing.areas.includes(slot.area.label)) existing.areas.push(slot.area.label);
          if (!existing.evidence.includes(slot.area.evidence)) existing.evidence.push(slot.area.evidence);
          existing.confidence = Math.max(existing.confidence, confidence);
          continue;
        }
        merged.set(id, {
          kind: pick.entry.kind,
          slug: pick.entry.slug,
          name: pick.entry.name,
          category: pick.entry.category,
          areas: [slot.area.label],
          evidence: [slot.area.evidence],
          confidence,
        });
      }
      const recommendations = [...merged.values()].sort((a, b) => b.confidence - a.confidence);
      try {
        (deps.record ?? recordJevDecision)({
          surface: 'catalogPick',
          model: outcome.model,
          questions: Object.keys(questions),
          probabilities: jevAnswerProbabilities(outcome.answers),
          confidence: jevAnswerConfidences(outcome.answers),
          decision: `recommend:${recommendations.length}/${slots.length}`,
          ...decisionResultUsage(outcome),
        });
      } catch {
        // O diário nunca derruba a recomendação.
      }
      const result: CatalogRecommendationsResult = {
        ok: true,
        areas,
        recommendations,
        provider: outcome.route?.provider,
        decidedAt: now,
      };
      recommendationCache.set(cacheKey, { at: now, result });
      return result;
    })();
    recommendationFlights.set(cacheKey, flight);
    try {
      return await flight;
    } finally {
      recommendationFlights.delete(cacheKey);
    }
  } catch {
    return { ok: false, reason: 'no-answer' };
  }
}
