/**
 * Lógica pura de apresentação do inventário de configs descobertas
 * (window.nexus.discovery.workspaceConfigs → canal discovery:workspace-configs).
 *
 * O bridge devolve `unknown` (o main já validou com zod); aqui narramos de
 * forma defensiva para um modelo de view agrupado por categoria e detectamos
 * shadowing por NOME dentro da categoria. Sem React, sem IPC — testável e
 * reutilizável. Nenhum valor de segredo trafega: env/headers já chegam
 * mascarados do main e não são exibidos aqui.
 */

export type InventoryCategoryId =
  | 'mcpServers'
  | 'contextFiles'
  | 'skills'
  | 'commands';

export type InventoryLevel = 'user' | 'project';

export interface InventoryItemView {
  source: string;
  level: InventoryLevel;
  path: string;
  name: string;
  /** Uma linha de detalhe secundário (comando MCP, kind de rule, descrição). */
  detail?: string;
  /** true quando o mesmo nome aparece em mais de uma fonte/nível na categoria. */
  shadowed: boolean;
}

export interface InventoryCategoryView {
  id: InventoryCategoryId;
  label: string;
  items: InventoryItemView[];
  /** Quantidade de nomes com shadowing (aparecem em >1 item). */
  shadowedNames: number;
}

export interface ConfigInventoryView {
  workspaceRoot: string | null;
  categories: InventoryCategoryView[];
  warnings: string[];
  /** Soma de itens de todas as categorias — base do estado vazio. */
  totalItems: number;
  discoveredAt: number | null;
}

/** Rótulo humano + ordem de precedência (maior = vence no shadowing). */
interface SourceMeta {
  label: string;
  priority: number;
}

const SOURCE_META: Record<string, SourceMeta> = {
  claude: { label: 'Claude', priority: 80 },
  codex: { label: 'Codex', priority: 70 },
  gemini: { label: 'Gemini', priority: 60 },
  opencode: { label: 'OpenCode', priority: 55 },
  cursor: { label: 'Cursor', priority: 50 },
  windsurf: { label: 'Windsurf', priority: 50 },
  cline: { label: 'Cline', priority: 40 },
  copilot: { label: 'Copilot', priority: 30 },
  vscode: { label: 'VS Code', priority: 20 },
  'agents-md': { label: 'AGENTS.md', priority: 10 },
  'mcp-json': { label: 'mcp.json', priority: 5 },
};

/** Rótulo amigável do ecossistema para o chip de source. */
export function sourceLabel(source: string): string {
  return SOURCE_META[source]?.label ?? source;
}

function sourcePriority(source: string): number {
  return SOURCE_META[source]?.priority ?? 0;
}

const LEVEL_LABEL: Record<InventoryLevel, string> = {
  user: 'user',
  project: 'project',
};

export function levelLabel(level: InventoryLevel): string {
  return LEVEL_LABEL[level];
}

const CATEGORY_LABEL: Record<InventoryCategoryId, string> = {
  mcpServers: 'MCP servers',
  contextFiles: 'Rules & context',
  skills: 'Skills',
  commands: 'Commands',
};

// --- narrowing defensivo do `unknown` do bridge --------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asLevel(value: unknown): InventoryLevel {
  return value === 'project' ? 'project' : 'user';
}

/** Detalhe secundário por categoria (nunca segredos). */
function detailFor(
  category: InventoryCategoryId,
  raw: Record<string, unknown>,
): string | undefined {
  switch (category) {
    case 'mcpServers': {
      const command = asString(raw.command);
      const url = asString(raw.url);
      const transport = asString(raw.transport);
      if (command) {
        const args = Array.isArray(raw.args)
          ? raw.args.filter((a): a is string => typeof a === 'string')
          : [];
        return [command, ...args].join(' ');
      }
      if (url) return transport ? `${transport} · ${url}` : url;
      return transport;
    }
    case 'contextFiles': {
      const kind = asString(raw.kind);
      return kind === 'rule' ? 'rule' : kind === 'context' ? 'context' : undefined;
    }
    case 'skills':
      return asString(raw.description);
    case 'commands':
      return undefined;
  }
}

function parseItems(
  category: InventoryCategoryId,
  raw: unknown,
): InventoryItemView[] {
  if (!Array.isArray(raw)) return [];
  const items: InventoryItemView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const source = asString(entry.source);
    const path = asString(entry.path);
    const name = asString(entry.name);
    if (!source || !path || !name) continue;
    items.push({
      source,
      level: asLevel(entry.level),
      path,
      name,
      detail: detailFor(category, entry),
      shadowed: false,
    });
  }
  return items;
}

/** Ordena por nome (agrupa homônimos), depois por precedência de source. */
function sortItems(items: InventoryItemView[]): InventoryItemView[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    const byPriority = sourcePriority(b.source) - sourcePriority(a.source);
    if (byPriority !== 0) return byPriority;
    return a.level.localeCompare(b.level);
  });
}

/** Marca itens cujo nome aparece em mais de uma entrada (shadowing). */
function markShadowing(items: InventoryItemView[]): {
  items: InventoryItemView[];
  shadowedNames: number;
} {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  let shadowedNames = 0;
  for (const count of counts.values()) {
    if (count > 1) shadowedNames += 1;
  }
  return {
    items: items.map((item) => ({
      ...item,
      shadowed: (counts.get(item.name) ?? 0) > 1,
    })),
    shadowedNames,
  };
}

function buildCategory(
  id: InventoryCategoryId,
  raw: unknown,
): InventoryCategoryView {
  const parsed = sortItems(parseItems(id, raw));
  const { items, shadowedNames } = markShadowing(parsed);
  return { id, label: CATEGORY_LABEL[id], items, shadowedNames };
}

const CATEGORY_ORDER: InventoryCategoryId[] = [
  'mcpServers',
  'contextFiles',
  'skills',
  'commands',
];

/** Constrói o modelo de view a partir do retorno cru do bridge. */
export function buildConfigInventoryView(raw: unknown): ConfigInventoryView {
  const root = isRecord(raw) ? raw : {};
  const categories = CATEGORY_ORDER.map((id) => buildCategory(id, root[id]));
  const warnings = Array.isArray(root.warnings)
    ? root.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  const totalItems = categories.reduce((sum, c) => sum + c.items.length, 0);
  return {
    workspaceRoot: asString(root.workspaceRoot) ?? null,
    categories,
    warnings,
    totalItems,
    discoveredAt:
      typeof root.discoveredAt === 'number' ? root.discoveredAt : null,
  };
}
