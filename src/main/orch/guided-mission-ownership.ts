import fs from "node:fs";
import path from "node:path";
import type { MissionIntentContract } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  ProcessGitRunner,
  type GitRunner,
} from "../runtime/git-command";
import { normalizeFileOwnership } from "../runtime/worktree-contract";

const GUIDED_OWNERSHIP_CATALOG_VERSION = 1 as const;

/**
 * Explicit greenfield surface. These are individual paths/directories, never
 * a repository-root or glob claim. Existing tracked top-level entries are
 * added at runtime.
 */
const GUIDED_GREENFIELD_OWNERSHIP_ENTRIES = [
  ".dockerignore",
  ".editorconfig",
  ".env.example",
  ".gitignore",
  ".prettierignore",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".storybook",
  "App.sln",
  "Cargo.lock",
  "Cargo.toml",
  "CMakeLists.txt",
  "CONTRIBUTING.md",
  "Directory.Build.props",
  "Directory.Build.targets",
  "Dockerfile",
  "Gemfile",
  "Gemfile.lock",
  "LICENSE",
  "Makefile",
  "Nexus.sln",
  "NuGet.config",
  "Package.resolved",
  "Package.swift",
  "Pipfile",
  "Pipfile.lock",
  "Procfile",
  "README.md",
  "Rakefile",
  "Sources",
  "Tests",
  "angular.json",
  "analysis_options.yaml",
  "android",
  "app",
  "app.json",
  "app.sln",
  "api",
  "apps",
  "artisan",
  "assets",
  "astro.config.mjs",
  "babel.config.cjs",
  "babel.config.js",
  "backend",
  "benches",
  "bin",
  "biome.json",
  "biome.jsonc",
  "bootstrap",
  "build.gradle",
  "build.gradle.kts",
  "build.rs",
  "bun.lock",
  "bun.lockb",
  "cmd",
  "cmake",
  "compose.yaml",
  "compose.yml",
  "components.json",
  "composer.json",
  "composer.lock",
  "config",
  "config.ru",
  "crates",
  "database",
  "deno.json",
  "deno.lock",
  "docker",
  "docker-compose.yaml",
  "docker-compose.yml",
  "docs",
  "drizzle.config.ts",
  "examples",
  "eslint.config.cjs",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.ts",
  "fly.toml",
  "go.mod",
  "go.sum",
  "global.json",
  "gradle",
  "gradlew",
  "gradlew.bat",
  "include",
  "index.html",
  "infra",
  "internal",
  "ios",
  "jest.config.cjs",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.ts",
  "k8s",
  "lib",
  "main.go",
  "main.py",
  "manage.py",
  "meson.build",
  "metro.config.js",
  "migrations",
  "mypy.ini",
  "netlify.toml",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuget.config",
  "nuxt.config.ts",
  "nx.json",
  "package-lock.json",
  "package.json",
  "packages",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pom.xml",
  "postcss.config.cjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "prisma",
  "pubspec.lock",
  "pubspec.yaml",
  "public",
  "pyproject.toml",
  "pytest.ini",
  "railway.json",
  "render.yaml",
  "requirements-dev.txt",
  "requirements.txt",
  "rollup.config.js",
  "rollup.config.mjs",
  "routes",
  "ruff.toml",
  "rust-toolchain.toml",
  "scripts",
  "server",
  "settings.gradle",
  "settings.gradle.kts",
  "setup.cfg",
  "setup.py",
  "spec",
  "src",
  "svelte.config.js",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "test",
  "tests",
  "tox.ini",
  "tsconfig.app.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "turbo.json",
  "uv.lock",
  "vercel.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.ts",
  "vitest.config.ts",
  "webpack.config.cjs",
  "webpack.config.js",
  "web",
  "yarn.lock",
] as const;

const FORBIDDEN_OWNERSHIP_ROOTS = new Set([
  ".",
  "..",
  "*",
  "**",
  "**/*",
  ".context",
  ".git",
  ".nexus",
  ".nexus-memory",
  ".env",
  "PRODUCT.md",
  "node_modules",
]);
// `git ls-tree` on a large repository can exceed 10s on a cold page cache, and
// expiring here is a hard `guided_plan_inventory_unavailable` — the mission
// dies because the machine was slow, not because anything was wrong.
const GUIDED_INVENTORY_GIT_TIMEOUT_MS = 30_000;
const MAX_APPROVED_INTENT_OWNERSHIP_CLAIMS = 64;
const MAX_GUIDED_OWNERSHIP_CLAIMS = 2_048;
const MAX_GUIDED_OWNERSHIP_BYTES = 32 * 1_024;
const guidedInventoryGit = new ProcessGitRunner();
const guidedGreenfieldOwnershipSet = new Set<string>(
  GUIDED_GREENFIELD_OWNERSHIP_ENTRIES,
);

const APPROVED_FILE_CUE =
  /\b(?:add|adiciona|adicione|arquivo|arquivos|artifact|artifacts|artefato|artefatos|caminho|create|cria|crie|criar|deliver|edite|editar|entrega|entregue|entregar|escreva|file|files|gera|gere|gerar|modifica|modify|nomeado|named|path|paths|produce|produz|produza|salva|save|salve|update|write)\b/iu;
const APPROVED_FILE_POST_CUE =
  /^\s*(?:contains|cont[eé]m|deve|must|precisa|ter[aá])\b/iu;
const APPROVED_FILE_NEGATION =
  /(?:\b(?:exceto|forbidden|jamais|never|nunca|proibido|sem|without)\b|\bdo\s+not\b|\bdon['’]t\b|\bmust\s+not\b|\bn[aã]o\b)/iu;
const APPROVED_FILE_MUTATION_VERB =
  /\b(?:add|adiciona|adicione|create|cria|crie|criar|deliver|edite|editar|entrega|entregue|entregar|escreva|gera|gere|gerar|modifica|modify|produce|produz|produza|salva|save|salve|update|write)\b/iu;
const APPROVED_FILE_CLAUSE_RESET =
  /\b(?:and|but|contudo|e|however|mas|por[eé]m|rather|instead)\b/giu;
const APPROVED_FILE_POSITIVE_NEGATION_IDIOM =
  /\b(?:do\s+not|don['’]t|never)\s+forget\s+to\b|\bn[aã]o\s+(?:deixe\s+de|esque[cç]a\s+de)\b|\bsem\s+deixar\s+de\b/giu;
const QUOTED_VALUE_CUE =
  /\b(?:content|conte[uú]do|text|texto|value|valor)(?:\s+(?:exact|exato|literal))?\s*(?::|=)?\s*$/iu;
const QUOTED_PATH_CANDIDATE = /(["`])([^"`\r\n]{1,256})\1/gu;
const BARE_PATH_CANDIDATE =
  /(?<![\p{L}\p{N}_+./@\\"'`-])([\p{L}\p{N}_+-][\p{L}\p{N}_+.-]*(?:[\\/][\p{L}\p{N}_+.-]+)*\.[\p{L}\p{N}]{1,16})(?![\p{L}\p{N}_+/@\\"'`-])/gu;

function isForbiddenOwnershipClaim(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const root = normalized.split("/")[0] ?? normalized;
  return (
    FORBIDDEN_OWNERSHIP_ROOTS.has(normalized) ||
    FORBIDDEN_OWNERSHIP_ROOTS.has(root)
  );
}

/**
 * Fits the claim list inside the schedule envelope.
 *
 * The byte budget is real: schedule metadata shares the task detail's 64 KiB
 * envelope with the approved goal and criteria, so an oversized list would
 * corrupt that contract. Refusing the mission over it was not — a large
 * repository simply could never start, with no way for the operator to shrink
 * an inventory that Nexus itself derived from `git ls-tree`.
 *
 * Truncation is deterministic (the list arrives sorted) and narrowing: fewer
 * claims can only reduce what a worker may touch, never widen it.
 */
function fitGuidedOwnershipBudget(claims: readonly string[]): string[] {
  const bounded = claims.slice(0, MAX_GUIDED_OWNERSHIP_CLAIMS);
  while (
    bounded.length > 0 &&
    Buffer.byteLength(JSON.stringify(bounded), "utf8") >
      MAX_GUIDED_OWNERSHIP_BYTES
  ) {
    bounded.pop();
  }
  return bounded;
}

function clausePrefixAt(text: string, index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const current = text[cursor] ?? "";
    if (current === ";" || current === "\n") {
      return text.slice(cursor + 1, index);
    }
    if (
      (current === "." || current === "!" || current === "?") &&
      /\s/u.test(text[cursor + 1] ?? "")
    ) {
      return text.slice(cursor + 1, index);
    }
  }
  return text.slice(0, index);
}

function candidateIsNegated(prefix: string): boolean {
  let effective = prefix;
  for (const match of prefix.matchAll(APPROVED_FILE_CLAUSE_RESET)) {
    const afterConnector = prefix.slice(match.index + match[0].length);
    if (APPROVED_FILE_MUTATION_VERB.test(afterConnector)) {
      effective = afterConnector;
    }
  }
  const comma = effective.lastIndexOf(",");
  if (comma >= 0) {
    const afterComma = effective.slice(comma + 1);
    if (APPROVED_FILE_MUTATION_VERB.test(afterComma)) {
      effective = afterComma;
    }
  }
  return APPROVED_FILE_NEGATION.test(
    effective.replace(APPROVED_FILE_POSITIVE_NEGATION_IDIOM, ""),
  );
}

function normalizeApprovedArtifactPath(rawValue: string): string | null {
  let value = rawValue.trim();
  if (value.startsWith("./")) value = value.slice(2);
  if (
    !value ||
    value.length > 256 ||
    /[\0-\x1f\x7f*?[\]{}<>|#$%&=]/.test(value) ||
    value.includes("://")
  ) {
    return null;
  }
  value = value.replaceAll("\\", "/");
  const rawSegments = value.split("/");
  if (
    rawSegments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment !== segment.trim() ||
        !/^[\p{L}\p{N} _+.,'()-]+$/u.test(segment),
    )
  ) {
    return null;
  }

  let normalized: string;
  try {
    normalized = normalizeFileOwnership(value);
  } catch {
    return null;
  }
  if (isForbiddenOwnershipClaim(normalized)) return null;
  const [root = "", ...rest] = normalized.split("/");
  // A newly requested hidden authority/config tree is never inferred from
  // prose. Safe conventional dotfiles are already enumerated in the catalog.
  if (
    (root.startsWith(".") || rest.some((segment) => segment.startsWith("."))) &&
    !guidedGreenfieldOwnershipSet.has(normalized)
  ) {
    return null;
  }
  const basename = normalized.split("/").at(-1) ?? "";
  const finalDot = basename.lastIndexOf(".");
  if (
    finalDot <= 0 ||
    !/^[\p{L}\p{N}]{1,16}$/u.test(basename.slice(finalDot + 1))
  ) {
    return null;
  }
  return normalized;
}

function approvedIntentOwnershipCandidates(
  text: string,
): readonly string[] {
  // Preserve offsets while ensuring URLs cannot be mistaken for repository
  // paths by the bare-token scanner.
  const scannable = text.replace(
    /\b(?:https?|file):\/\/[^\s"'`]+/giu,
    (url) => " ".repeat(url.length),
  );
  const claims = new Set<string>();
  const quotedSpans: Array<readonly [number, number]> = [];
  const consider = (
    rawValue: string,
    index: number,
    end: number,
    codeDelimited: boolean,
    quoted: boolean,
  ): void => {
    const prefix = clausePrefixAt(scannable, index);
    if (candidateIsNegated(prefix)) return;
    if (quoted && QUOTED_VALUE_CUE.test(prefix)) return;
    if (
      !codeDelimited &&
      !rawValue.includes("/") &&
      !rawValue.includes("\\") &&
      !APPROVED_FILE_CUE.test(prefix) &&
      !APPROVED_FILE_POST_CUE.test(scannable.slice(end))
    ) {
      return;
    }
    const normalized = normalizeApprovedArtifactPath(rawValue);
    if (normalized) claims.add(normalized);
  };

  for (const match of scannable.matchAll(QUOTED_PATH_CANDIDATE)) {
    const end = match.index + match[0].length;
    quotedSpans.push([match.index, end]);
    consider(
      match[2] ?? "",
      match.index,
      end,
      match[1] === "`",
      true,
    );
  }
  for (const match of scannable.matchAll(BARE_PATH_CANDIDATE)) {
    if (
      quotedSpans.some(
        ([start, end]) => match.index >= start && match.index < end,
      )
    ) {
      continue;
    }
    consider(
      match[1] ?? "",
      match.index,
      match.index + match[0].length,
      false,
      false,
    );
  }
  return Object.freeze([...claims]);
}

/**
 * Derive only exact file claims from the human-approved intent contract.
 *
 * This deliberately does not infer directories or globs: an explicit new
 * artifact can widen one exact merge path, while the existing repository/tree
 * inventory remains the authority for broader surfaces.
 */
export function approvedIntentOwnershipClaims(
  contract: Pick<MissionIntentContract, "goal" | "acceptanceCriteria">,
): readonly string[] {
  // A goal that names many files is a big refactor, not an attack. Refusing it
  // meant the more precisely the operator described the work, the more likely
  // the mission was to die. The cap still bounds the envelope; it simply stops
  // collecting instead of throwing. Repository/tree inventory remains the
  // authority for anything not captured here.
  const claims = new Set<string>();
  for (const text of [contract.goal, ...contract.acceptanceCriteria]) {
    for (const claim of approvedIntentOwnershipCandidates(text)) {
      if (claims.size >= MAX_APPROVED_INTENT_OWNERSHIP_CLAIMS) break;
      claims.add(claim);
    }
    if (claims.size >= MAX_APPROVED_INTENT_OWNERSHIP_CLAIMS) break;
  }
  return Object.freeze([...claims].sort((left, right) =>
    left.localeCompare(right),
  ));
}

export function addApprovedIntentOwnershipClaims(
  repositoryClaims: readonly string[],
  contract: Pick<MissionIntentContract, "goal" | "acceptanceCriteria">,
): readonly string[] {
  const claims = new Set<string>();
  for (const rawClaim of repositoryClaims) {
    const normalized = normalizeFileOwnership(rawClaim);
    if (isForbiddenOwnershipClaim(normalized)) {
      throw new Error(
        "guided_plan_ownership_invalid: o inventário contém um caminho reservado",
      );
    }
    claims.add(normalized);
  }
  for (const claim of approvedIntentOwnershipClaims(contract)) {
    claims.add(claim);
  }
  const ordered = [...claims].sort((left, right) =>
    left.localeCompare(right),
  );
  return Object.freeze(fitGuidedOwnershipBudget(ordered));
}

/**
 * Mutation ownership for Guided delivery: intent artifacts only — never the
 * full repository inventory. Callers may pass an already-expanded blast set as
 * `extraClaims`; the inventory catalog remains an allowlist/context, not a claim.
 */
export function resolveGuidedMutationOwnership(
  contract: Pick<MissionIntentContract, "goal" | "acceptanceCriteria">,
  extraClaims: readonly string[] = [],
): readonly string[] {
  const claims = new Set<string>();
  for (const claim of approvedIntentOwnershipClaims(contract)) {
    claims.add(claim);
  }
  for (const rawClaim of extraClaims) {
    const normalized = normalizeFileOwnership(rawClaim);
    if (isForbiddenOwnershipClaim(normalized)) {
      throw new Error(
        "guided_plan_ownership_invalid: o blast contém um caminho reservado",
      );
    }
    claims.add(normalized);
  }
  const ordered = [...claims].sort((left, right) =>
    left.localeCompare(right),
  );
  return Object.freeze(fitGuidedOwnershipBudget(ordered));
}

/** Free-form plans that reclaim most of the greenfield catalog are repo-wide. */
export const MAX_FREE_FORM_GREENFIELD_OVERLAP = 24;
export const MAX_FREE_FORM_TOP_LEVEL_ROOTS = 24;
export const MAX_FREE_FORM_OWNERSHIP_FILES = 96;

/**
 * Detect free-form plans that effectively claim the whole repository.
 *
 * Counts unique greenfield-catalog roots (exact or nested under a catalog
 * entry), distinct top-level path roots, and raw file volume — any one over
 * the budget is repo-wide.
 */
export function ownershipLooksRepoWide(
  files: readonly string[],
): boolean {
  if (files.length === 0) return false;
  if (files.length >= MAX_FREE_FORM_OWNERSHIP_FILES) return true;
  const catalogHits = new Set<string>();
  const topLevelRoots = new Set<string>();
  for (const raw of files) {
    let normalized: string;
    try {
      normalized = normalizeFileOwnership(raw);
    } catch {
      continue;
    }
    const segments = normalized.split("/");
    const root = segments[0] ?? normalized;
    topLevelRoots.add(root);
    // Exact match, top-level catalog root, or nested under a multi-segment
    // catalog entry (e.g. claim `src/main/foo` when catalog has `src/main`).
    if (guidedGreenfieldOwnershipSet.has(normalized)) {
      catalogHits.add(normalized);
      continue;
    }
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      if (guidedGreenfieldOwnershipSet.has(prefix)) {
        catalogHits.add(prefix);
        break;
      }
    }
  }
  return (
    catalogHits.size >= MAX_FREE_FORM_GREENFIELD_OVERLAP ||
    topLevelRoots.size >= MAX_FREE_FORM_TOP_LEVEL_ROOTS
  );
}

function validateOwnershipCatalog(
  version: typeof GUIDED_OWNERSHIP_CATALOG_VERSION,
  entries: readonly string[],
): void {
  if (version !== 1 || new Set(entries).size !== entries.length) {
    throw new Error("guided ownership catalog is invalid");
  }
  if (
    entries.some(
      (entry) =>
        !entry ||
        /[\0-\x1f\x7f]/.test(entry) ||
        isForbiddenOwnershipClaim(entry),
    )
  ) {
    throw new Error("guided ownership catalog contains an unsafe claim");
  }
}

validateOwnershipCatalog(
  GUIDED_OWNERSHIP_CATALOG_VERSION,
  GUIDED_GREENFIELD_OWNERSHIP_ENTRIES,
);

export const GUIDED_GREENFIELD_OWNERSHIP = Object.freeze(
  GUIDED_GREENFIELD_OWNERSHIP_ENTRIES,
);

/**
 * Convert a bounded top-level Git tree into the ownership surface shared by
 * the sequential guided delivery waves.
 */
export function repositoryOwnershipClaimsFromGitTree(
  rawEntries: readonly string[],
): readonly string[] {
  const claims = new Set<string>(GUIDED_GREENFIELD_OWNERSHIP);
  for (const raw of rawEntries) {
    const value = raw;
    if (
      !value ||
      /[\0-\x1f\x7f]/.test(value) ||
      isForbiddenOwnershipClaim(value)
    ) {
      continue;
    }
    const normalized = normalizeFileOwnership(value);
    if (isForbiddenOwnershipClaim(normalized)) continue;
    claims.add(normalized);
  }
  const ordered = [...claims].sort((left, right) => left.localeCompare(right));
  return Object.freeze(fitGuidedOwnershipBudget(ordered));
}

export function listRepositoryOwnershipClaims(
  scope: ProjectExecutionScope,
  git: GitRunner = guidedInventoryGit,
): readonly string[] {
  let rootRealPath: string;
  let rootEntries: readonly string[];
  try {
    const resolvedRoot = path.resolve(scope.rootRealPath);
    rootRealPath = fs.realpathSync(resolvedRoot);
    const stat = fs.lstatSync(resolvedRoot);
    if (
      scope.rootRealPath !== resolvedRoot ||
      rootRealPath !== resolvedRoot ||
      stat.isSymbolicLink() ||
      !stat.isDirectory()
    ) {
      throw new Error("o workspace não é um diretório real canônico");
    }
    rootEntries = fs.readdirSync(rootRealPath);
  } catch (error) {
    throw new Error(
      "guided_plan_inventory_unavailable: o Nexus não conseguiu validar o workspace aprovado",
      { cause: error },
    );
  }

  // A brand-new folder has no Git identity yet. The planner may still seal a
  // safe greenfield surface; worktree materialization remains responsible for
  // creating/proving the later Git baseline.
  if (rootEntries.length === 0) {
    return repositoryOwnershipClaimsFromGitTree([]);
  }

  try {
    const insideWorktree = git
      .run(rootRealPath, ["rev-parse", "--is-inside-work-tree"], {
        timeoutMs: GUIDED_INVENTORY_GIT_TIMEOUT_MS,
      })
      .stdout.trim();
    if (insideWorktree !== "true") {
      throw new Error("o workspace não pertence a um worktree Git");
    }
  } catch (error) {
    throw new Error(
      "guided_plan_inventory_unavailable: o Nexus não conseguiu provar o repositório Git aprovado",
      { cause: error },
    );
  }

  let output: string;
  try {
    output = git.run(
      rootRealPath,
      ["ls-tree", "-z", "--name-only", "HEAD"],
      { timeoutMs: GUIDED_INVENTORY_GIT_TIMEOUT_MS },
    ).stdout;
  } catch (error) {
    // `git init` has a valid repository/worktree but no commit to inventory.
    // Prove that HEAD is genuinely unborn before consulting status. A clean
    // status alone cannot distinguish an unborn repository from a transient
    // or corrupted `ls-tree` failure in a committed repository.
    let headVerification: ReturnType<GitRunner["run"]>;
    try {
      headVerification = git.run(
        rootRealPath,
        ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        {
          allowFailure: true,
          timeoutMs: GUIDED_INVENTORY_GIT_TIMEOUT_MS,
        },
      );
    } catch (headError) {
      throw new Error(
        "guided_plan_inventory_unavailable: o Nexus não conseguiu provar o estado de HEAD do repositório aprovado",
        { cause: headError },
      );
    }
    if (headVerification.status !== 1) {
      throw new Error(
        "guided_plan_inventory_unavailable: o Nexus não conseguiu ler o inventário Git aprovado",
        { cause: error },
      );
    }

    // Only the canonical `--verify --quiet` exit 1 means that HEAD is absent.
    // The repository must also be clean before Nexus can expose the explicit
    // greenfield surface. We intentionally mint no SHA here.
    let status: string;
    try {
      status = git.run(
        rootRealPath,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ],
        { timeoutMs: GUIDED_INVENTORY_GIT_TIMEOUT_MS },
      ).stdout;
    } catch (statusError) {
      throw new Error(
        "guided_plan_inventory_unavailable: o Nexus não conseguiu ler o inventário Git aprovado",
        { cause: statusError },
      );
    }
    if (status.length > 0) {
      throw new Error(
        "guided_plan_unborn_with_files: faça o primeiro commit dos arquivos existentes e tente iniciar a missão novamente",
      );
    }
    return repositoryOwnershipClaimsFromGitTree([]);
  }
  return repositoryOwnershipClaimsFromGitTree(
    output.split("\0").filter(Boolean),
  );
}
