/**
 * Derivado de oh-my-pi (omp) — packages/coding-agent/src/capability/{types,mcp,
 * context-file,skill,slash-command}.ts
 * https://github.com/can1357/oh-my-pi @ 03c48d073bd4849726cc14750b5aecfa310bdf26 (MIT)
 * Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük — ver NOTICE.
 *
 * Adaptação NexusIDE: tipos das 4 capabilities da v1 (MCP servers, context/rule
 * files, skills, slash commands). O `_source` do omp vira campos planos
 * {source, level, path, name} em cada item.
 */
import type { FsProbe } from './fs-probe';

/**
 * Ecossistemas conhecidos, com a prioridade original do omp (maior vence no
 * dedup). opencode/windsurf/vscode ainda não têm provider portado, mas a
 * tabela completa é preservada para a próxima onda.
 */
export const DISCOVERY_SOURCES = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'windsurf',
  'cline',
  'copilot',
  'vscode',
  'agents-md',
  'mcp-json',
] as const;

export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export const DISCOVERY_SOURCE_PRIORITY: Readonly<
  Record<DiscoverySource, number>
> = {
  claude: 80,
  codex: 70,
  gemini: 60,
  opencode: 55,
  cursor: 50,
  windsurf: 50,
  cline: 40,
  copilot: 30,
  vscode: 20,
  'agents-md': 10,
  'mcp-json': 5,
};

export type DiscoveryLevel = 'user' | 'project';

/** Atribuição comum a todo item descoberto. */
export interface DiscoveredItemMeta {
  /** Ecossistema de origem (provider omp). */
  source: DiscoverySource;
  /** Nível: config do usuário (home) ou do projeto (workspace). */
  level: DiscoveryLevel;
  /** Caminho absoluto do arquivo de origem. */
  path: string;
  /** Nome canônico do item (chave de dedup quando aplicável). */
  name: string;
}

/** Config canônica de MCP server (formato do omp, campos relevantes). */
export interface DiscoveredMcpServer extends DiscoveredItemMeta {
  command?: string;
  args?: string[];
  /** Valores já expandidos (${VAR}); NUNCA logar estes valores. */
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Valores podem conter tokens; NUNCA logar estes valores. */
  headers?: Record<string, string>;
  transport?: 'stdio' | 'sse' | 'http';
  timeout?: number;
  enabled?: boolean;
}

/**
 * Context/rule file. `kind: 'context'` = instrução persistente (CLAUDE.md,
 * AGENTS.md, GEMINI.md); `kind: 'rule'` = regra escopada (.cursor/rules/*.mdc,
 * .cursorrules, .clinerules, *.instructions.md).
 */
export interface DiscoveredContextFile extends DiscoveredItemMeta {
  kind: 'context' | 'rule';
}

export interface DiscoveredSkill extends DiscoveredItemMeta {
  description?: string;
}

export type DiscoveredCommand = DiscoveredItemMeta;

/** Contexto passado a cada provider (LoadContext do omp, sem repoRoot). */
export interface DiscoveryContext {
  /** Raiz do workspace (cwd do omp) — varredura nunca sobe além dela. */
  workspaceRoot: string;
  /** Home do usuário (injetável em teste). */
  home: string;
  /** Ambiente para expansão de ${VAR}; default process.env no serviço. */
  env: Readonly<Record<string, string | undefined>>;
  /** Camada de fs com fingerprint de mtimes (substitui o cache do omp). */
  io: FsProbe;
}

/** Resultado de um provider (LoadResult do omp, agrupado pelas 4 categorias). */
export interface ProviderResult {
  mcpServers: DiscoveredMcpServer[];
  contextFiles: DiscoveredContextFile[];
  skills: DiscoveredSkill[];
  commands: DiscoveredCommand[];
  /** Avisos de parse/leitura — apenas caminhos e chaves, nunca valores. */
  warnings: string[];
}

export function emptyProviderResult(): ProviderResult {
  return {
    mcpServers: [],
    contextFiles: [],
    skills: [],
    commands: [],
    warnings: [],
  };
}
