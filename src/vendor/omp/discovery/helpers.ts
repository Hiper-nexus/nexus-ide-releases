/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/discovery/helpers.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Adaptação NexusIDE: helpers sem pi-utils/Bun — parse de JSON tolerante,
 * expansão de env vars (${VAR} / ${VAR:-default}) sobre ctx.env, parser de
 * frontmatter mínimo (só pares chave: valor de primeira linha), varredura de
 * skills e de comandos markdown. Nenhum helper loga valores de env/headers.
 */
import path from 'node:path';
import type { FsProbe } from './fs-probe';
import type {
  DiscoveredCommand,
  DiscoveredMcpServer,
  DiscoveredSkill,
  DiscoveryLevel,
  DiscoverySource,
} from './types';

/** tryParseJson do pi-utils: null em vez de exceção. */
export function tryParseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Expande variáveis de ambiente em uma string.
 * Suporta ${VAR} e ${VAR:-default} (paridade omp). Variável desconhecida sem
 * default permanece literal.
 */
function expandEnvVars(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(
    /\$\{([^}:]+)(?::-([^}]*))?\}/g,
    (_match, varName: string, defaultValue?: string) => {
      const envValue = env[varName];
      if (envValue !== undefined) return envValue;
      if (defaultValue !== undefined) return defaultValue;
      return `\${${varName}}`;
    },
  );
}

/** Expansão recursiva de env vars em objetos/arrays/strings (paridade omp). */
export function expandEnvVarsDeep<T>(
  obj: T,
  env: Readonly<Record<string, string | undefined>>,
): T {
  if (typeof obj === 'string') {
    return expandEnvVars(obj, env) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVarsDeep(item, env)) as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsDeep(value, env);
    }
    return result as T;
  }
  return obj;
}

/**
 * Parser de frontmatter mínimo (substitui o parseFrontmatter do pi-utils):
 * bloco `---` inicial com pares `chave: valor` de linha única. Suficiente
 * para name/description/enabled de SKILL.md — valores YAML complexos são
 * ignorados sem erro.
 */
export function parseFrontmatterLite(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {};
  const bodyStart = content.indexOf('\n');
  if (bodyStart === -1) return {};
  const end = content.indexOf('\n---', bodyStart);
  if (end === -1) return {};
  const block = content.slice(bodyStart + 1, end);
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Record<string,string> validado em runtime (JSON vindo do usuário). */
export function coerceStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string') out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Converte um bloco `mcpServers: { nome: {...} }` (já com env expandido) para
 * o formato canônico. Validação de tipos em runtime (paridade gemini.ts do
 * omp — a forma mais defensiva entre os providers).
 */
export function parseMcpServersRecord(
  raw: unknown,
  meta: { source: DiscoverySource; level: DiscoveryLevel; path: string },
): DiscoveredMcpServer[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: DiscoveredMcpServer[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim()) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cfg = value as Record<string, unknown>;
    const transport =
      cfg.type === 'stdio' || cfg.type === 'sse' || cfg.type === 'http'
        ? cfg.type
        : undefined;
    out.push({
      source: meta.source,
      level: meta.level,
      path: meta.path,
      name,
      command: typeof cfg.command === 'string' ? cfg.command : undefined,
      args: Array.isArray(cfg.args)
        ? cfg.args.filter((a): a is string => typeof a === 'string')
        : undefined,
      env: coerceStringRecord(cfg.env),
      cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
      url: typeof cfg.url === 'string' ? cfg.url : undefined,
      headers: coerceStringRecord(cfg.headers),
      transport,
      timeout:
        typeof cfg.timeout === 'number' &&
        Number.isFinite(cfg.timeout) &&
        cfg.timeout >= 0
          ? cfg.timeout
          : undefined,
      enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : undefined,
    });
  }
  return out;
}

// Ordenação estável de skills (compareSkillOrder do omp).
function compareSkillOrder(a: DiscoveredSkill, b: DiscoveredSkill): number {
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return (
    cmp(a.name.toLowerCase(), b.name.toLowerCase()) ||
    cmp(a.name, b.name) ||
    cmp(a.path, b.path)
  );
}

export interface ScanSkillsOptions {
  /** Exige `description` no frontmatter (Agent Skills spec — copilot). */
  requireDescription?: boolean;
}

/**
 * Varre `<dir>/<nome>/SKILL.md` (scanSkillsFromDir do omp).
 * Divergência: só diretórios reais (symlinks pulados, padrão skills-catalog).
 */
export function scanSkillsFromDir(
  io: FsProbe,
  dir: string,
  meta: { source: DiscoverySource; level: DiscoveryLevel },
  options: ScanSkillsOptions = {},
): { skills: DiscoveredSkill[]; warnings: string[] } {
  const skills: DiscoveredSkill[] = [];
  const warnings: string[] = [];
  for (const entry of io.readDirEntries(dir)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const skillPath = path.join(dir, entry.name, 'SKILL.md');
    const content = io.readTextFile(skillPath);
    if (content === null) continue;
    const frontmatter = parseFrontmatterLite(content);
    if (frontmatter.enabled === 'false') continue;
    if (options.requireDescription && !frontmatter.description) continue;
    const name = frontmatter.name?.trim() || entry.name;
    skills.push({
      source: meta.source,
      level: meta.level,
      path: skillPath,
      name,
      description: frontmatter.description || undefined,
    });
  }
  // Leituras de fs não são determinísticas na ordem — ordena após carregar.
  skills.sort(compareSkillOrder);
  return { skills, warnings };
}

export interface ScanCommandsOptions {
  /** Recursão em subdiretórios. */
  recursive: boolean;
  /** Sufixo do arquivo (default '.md'; copilot usa '.prompt.md'). */
  suffix?: string;
}

/**
 * Varre comandos markdown em `dir`. Nome = caminho relativo sem sufixo, com
 * separadores vertidos em ':' — adaptação do addClaudeCommandNamespaceAliases
 * do omp: em vez de duplicar entradas (original + alias), o inventário guarda
 * só o nome canônico namespaced (`ops:restart`).
 */
export function scanCommandsFromDir(
  io: FsProbe,
  dir: string,
  meta: { source: DiscoverySource; level: DiscoveryLevel },
  options: ScanCommandsOptions,
): DiscoveredCommand[] {
  const suffix = options.suffix ?? '.md';
  const files = io.walkFiles(dir, {
    extensions: ['md'],
    recursive: options.recursive,
  });
  const out: DiscoveredCommand[] = [];
  for (const filePath of files) {
    const rel = path.relative(dir, filePath);
    if (!rel.endsWith(suffix)) continue;
    const name = rel
      .slice(0, -suffix.length)
      .split(path.sep)
      .filter(Boolean)
      .join(':');
    if (!name) continue;
    out.push({ source: meta.source, level: meta.level, path: filePath, name });
  }
  return out;
}
