/**
 * Harness por tarefa (paridade Overclock 1.4 — tabela CRUD + receipt OVKA-748).
 *
 * O spawn por `task` resolve CLI/model/effort/skills/agent a partir desta
 * tabela. Campo explícito do chamador vence a tabela; tipo desconhecido cai no
 * default DECLARADO (nunca recusa). O recibo (`harness:` / `decisor:` /
 * `origens:`) é o que o agente lê para saber o que foi decidido.
 *
 * Skill gate OVKA-713: ausência de filtro LIBERTA (`filtro=nenhum`); filtro
 * declarado é whitelist dura — exatamente o declarado, sem universais extras.
 */

export type HarnessEffort = 'low' | 'medium' | 'high';

export interface HarnessTypeValues {
  cli?: string;
  model?: string;
  account?: string;
  effort?: HarnessEffort;
  skills?: readonly string[];
  agent?: string;
}

export interface HarnessType {
  readonly typeId: string;
  name: string;
  description?: string;
  values: HarnessTypeValues;
  /** Linha de fábrica — `restore_type` traz estes valores de volta. */
  readonly factory?: boolean;
}

export interface HarnessCategory {
  readonly categoryId: string;
  name: string;
  types: HarnessType[];
  readonly factory?: boolean;
}

export interface HarnessTable {
  version: number;
  categories: HarnessCategory[];
}

export const HARNESS_TABLE_VERSION = 2;

/** Tipo default declarado quando a classificação não acha linha (OVKA-748). */
export const HARNESS_DEFAULT_TYPE_ID = 'default';

export function factoryHarnessTable(): HarnessTable {
  return {
    version: HARNESS_TABLE_VERSION,
    categories: [
      {
        categoryId: 'development',
        name: 'Desenvolvimento',
        factory: true,
        types: [
          { typeId: 'B1', name: 'fix de bug', factory: true, values: { effort: 'medium' } },
          { typeId: 'B2', name: 'feature de produto', factory: true, values: { effort: 'medium' } },
          { typeId: 'B3', name: 'hub/tooling/scripts', factory: true, values: { effort: 'medium' } },
          { typeId: 'B4', name: 'release/build', factory: true, values: { effort: 'high' } },
          { typeId: 'B5', name: 'investigação/análise', factory: true, values: { effort: 'low' } },
          { typeId: 'B6', name: 'docs/processo', factory: true, values: { effort: 'low' } },
        ],
      },
      {
        categoryId: 'frontend',
        name: 'Frontend',
        factory: true,
        types: [
          { typeId: 'frontend-design-dna', name: 'design DNA', factory: true, values: { effort: 'medium' } },
          { typeId: 'frontend-build-page', name: 'fazer página', factory: true, values: { effort: 'medium' } },
          { typeId: 'frontend-replicate-page', name: 'replicar página', factory: true, values: { effort: 'medium' } },
        ],
      },
      {
        categoryId: 'general',
        name: 'Geral',
        factory: true,
        types: [
          {
            typeId: HARNESS_DEFAULT_TYPE_ID,
            name: 'padrão (tipo sem linha)',
            factory: true,
            values: { effort: 'medium' },
          },
        ],
      },
    ],
  };
}

/**
 * Desserializa uma tabela persistida. Forma inválida = fábrica (nunca trava
 * o boot nem o spawn por settings corrompidos).
 */
export function parseHarnessTable(raw: unknown): HarnessTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return factoryHarnessTable();
  }
  const input = raw as Partial<HarnessTable>;
  if (!Array.isArray(input.categories)) return factoryHarnessTable();
  const categories: HarnessCategory[] = [];
  for (const category of input.categories) {
    if (!category || typeof category !== 'object') continue;
    const categoryId = String((category as HarnessCategory).categoryId ?? '');
    const name = String((category as HarnessCategory).name ?? categoryId);
    if (!categoryId) continue;
    const types: HarnessType[] = [];
    for (const type of (category as HarnessCategory).types ?? []) {
      if (!type || typeof type !== 'object') continue;
      const typeId = String((type as HarnessType).typeId ?? '');
      if (!typeId) continue;
      const values = ((type as HarnessType).values ?? {}) as HarnessTypeValues;
      types.push({
        typeId,
        name: String((type as HarnessType).name ?? typeId),
        ...((type as HarnessType).description !== undefined
          ? { description: String((type as HarnessType).description) }
          : {}),
        values: {
          ...(values.cli ? { cli: String(values.cli) } : {}),
          ...(values.model ? { model: String(values.model) } : {}),
          ...(values.account ? { account: String(values.account) } : {}),
          ...(values.effort === 'low' || values.effort === 'medium' || values.effort === 'high'
            ? { effort: values.effort }
            : {}),
          ...(Array.isArray(values.skills)
            ? { skills: values.skills.map((s) => String(s)).slice(0, 32) }
            : {}),
          ...(values.agent ? { agent: String(values.agent) } : {}),
        },
        factory: (type as HarnessType).factory === true,
      });
    }
    categories.push({
      categoryId,
      name,
      types,
      factory: (category as HarnessCategory).factory === true,
    });
  }
  if (categories.length === 0) return factoryHarnessTable();
  return {
    version:
      typeof input.version === 'number' && Number.isInteger(input.version)
        ? input.version
        : HARNESS_TABLE_VERSION,
    categories,
  };
}

/** Forma persistível (plain JSON) da tabela. */
export function serializeHarnessTable(table: HarnessTable): Record<string, unknown> {
  return JSON.parse(JSON.stringify(table)) as Record<string, unknown>;
}

export type HarnessOp =
  | { op: 'create_category'; categoryId: string; name: string }
  | { op: 'rename_category'; categoryId: string; name: string }
  | { op: 'remove_category'; categoryId: string }
  | { op: 'create_type'; categoryId: string; typeId: string; name: string; set?: HarnessTypeValues; values?: HarnessTypeValues }
  | { op: 'edit_type'; typeId: string; name?: string; description?: string; set?: HarnessTypeValues; values?: HarnessTypeValues }
  | { op: 'remove_type'; typeId: string }
  | { op: 'restore_type'; typeId: string }
  | { op: 'restore_all' };

export interface HarnessApplyResult {
  ok: true;
  table: HarnessTable;
}

export interface HarnessRefusal {
  ok: false;
  message?: string;
  problems?: Array<{ fix: string }>;
}

export type HarnessApplyOutcome = HarnessApplyResult | HarnessRefusal;

function findType(
  table: HarnessTable,
  typeId: string,
): { category: HarnessCategory; type: HarnessType; index: number } | null {
  for (const category of table.categories) {
    const index = category.types.findIndex((t) => t.typeId === typeId);
    if (index >= 0) return { category, type: category.types[index], index };
  }
  return null;
}

function findFactoryType(typeId: string): HarnessType | null {
  for (const category of factoryHarnessTable().categories) {
    const found = category.types.find((t) => t.typeId === typeId);
    if (found) return found;
  }
  return null;
}

function normalizeValues(
  input: HarnessTypeValues | undefined,
  base: HarnessTypeValues,
  replace: boolean,
): HarnessTypeValues {
  if (!input) return replace ? {} : { ...base };
  const next: HarnessTypeValues = replace ? {} : { ...base };
  if (input.cli !== undefined) next.cli = input.cli || undefined;
  if (input.model !== undefined) next.model = input.model || undefined;
  if (input.account !== undefined) next.account = input.account || undefined;
  if (input.effort !== undefined) {
    if (!['low', 'medium', 'high'].includes(input.effort)) {
      throw new Error(`effort inválido: ${input.effort}`);
    }
    next.effort = input.effort;
  }
  if (input.skills !== undefined) next.skills = [...input.skills];
  if (input.agent !== undefined) next.agent = input.agent || undefined;
  if (replace && input.effort === undefined) {
    throw new Error('values exige effort');
  }
  return next;
}

/**
 * Aplica um lote all-or-nothing. Qualquer recusa NÃO escreve nada e devolve
 * `message` (op errada) ou `problems[].fix` (modelo/conta/CLI/skill).
 */
export function applyHarnessChanges(
  current: HarnessTable,
  changes: readonly HarnessOp[],
): HarnessApplyOutcome {
  // clone raso o suficiente: categorias/tipos são reconstruídos por cópia
  const table: HarnessTable = {
    version: current.version,
    categories: current.categories.map((c) => ({
      ...c,
      types: c.types.map((t) => ({ ...t, values: { ...t.values, skills: t.values.skills ? [...t.values.skills] : undefined } })),
    })),
  };

  try {
    for (const change of changes) {
      switch (change.op) {
        case 'create_category': {
          if (table.categories.some((c) => c.categoryId === change.categoryId)) {
            return { ok: false, message: `category already exists: ${change.categoryId}` };
          }
          table.categories.push({ categoryId: change.categoryId, name: change.name, types: [] });
          break;
        }
        case 'rename_category': {
          const category = table.categories.find((c) => c.categoryId === change.categoryId);
          if (!category) return { ok: false, message: `unknown category: ${change.categoryId}` };
          category.name = change.name;
          break;
        }
        case 'remove_category': {
          const index = table.categories.findIndex((c) => c.categoryId === change.categoryId);
          if (index < 0) return { ok: false, message: `unknown category: ${change.categoryId}` };
          table.categories.splice(index, 1);
          break;
        }
        case 'create_type': {
          if (findType(table, change.typeId)) {
            return { ok: false, message: `type already exists: ${change.typeId}` };
          }
          const category = table.categories.find((c) => c.categoryId === change.categoryId);
          if (!category) return { ok: false, message: `unknown category: ${change.categoryId}` };
          const values = normalizeValues(change.set ?? change.values, {}, Boolean(change.values));
          category.types.push({ typeId: change.typeId, name: change.name, values });
          break;
        }
        case 'edit_type': {
          const found = findType(table, change.typeId);
          if (!found) {
            return {
              ok: false,
              message: `unknown type: ${change.typeId}`,
              problems: [
                {
                  fix: `tipos válidos: ${table.categories.flatMap((c) => c.types.map((t) => t.typeId)).join(', ')}`,
                },
              ],
            };
          }
          if (change.name !== undefined) found.type.name = change.name;
          if (change.description !== undefined) found.type.description = change.description;
          if (change.values) {
            found.type.values = normalizeValues(change.values, found.type.values, true);
          } else if (change.set) {
            found.type.values = normalizeValues(change.set, found.type.values, false);
          }
          break;
        }
        case 'remove_type': {
          const found = findType(table, change.typeId);
          if (!found) return { ok: false, message: `unknown type: ${change.typeId}` };
          found.category.types.splice(found.index, 1);
          break;
        }
        case 'restore_type': {
          const factory = findFactoryType(change.typeId);
          if (!factory) return { ok: false, message: `unknown factory type: ${change.typeId}` };
          const found = findType(table, change.typeId);
          const factoryCategory = factoryHarnessTable().categories.find((c) =>
            c.types.some((t) => t.typeId === change.typeId),
          )!;
          if (found) {
            found.type.name = factory.name;
            found.type.values = { ...factory.values, skills: factory.values.skills ? [...factory.values.skills] : undefined };
          } else {
            const category =
              table.categories.find((c) => c.categoryId === factoryCategory.categoryId) ??
              table.categories[0];
            category.types.push({
              typeId: factory.typeId,
              name: factory.name,
              values: { ...factory.values },
              factory: true,
            });
          }
          break;
        }
        case 'restore_all': {
          return { ok: true, table: factoryHarnessTable() };
        }
        default: {
          const never: never = change;
          return { ok: false, message: `op desconhecida: ${JSON.stringify(never)}` };
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, table };
}

export interface HarnessResolution {
  readonly typeId: string;
  readonly categoryId: string;
  readonly values: HarnessTypeValues;
  /** `table` = linha real; `default` = tipo default declarado. */
  readonly via: 'table' | 'default';
  readonly typeName: string;
}

/**
 * Resolve um `task` (id de tipo, nome ou texto) para uma linha.
 * Tipo desconhecido → default declarado, nunca recusa.
 */
export function resolveHarnessType(
  table: HarnessTable,
  task: string,
): HarnessResolution {
  const needle = task.trim().toLowerCase();
  for (const category of table.categories) {
    for (const type of category.types) {
      if (type.typeId.toLowerCase() === needle || type.name.toLowerCase() === needle) {
        return {
          typeId: type.typeId,
          categoryId: category.categoryId,
          typeName: type.name,
          values: type.values,
          via: 'table',
        };
      }
    }
  }
  // F-1332: casa os tokens do TIPO dentro da tarefa (antes era o contrário:
  // exigia que o nome do tipo contivesse a frase inteira). Mais tokens
  // casados vence; empate fica com a ordem da tabela.
  const taskWords = harnessTokens(needle);
  let best: { type: HarnessType; categoryId: string; score: number } | null = null;
  for (const category of table.categories) {
    for (const type of category.types) {
      if (type.typeId === HARNESS_DEFAULT_TYPE_ID) continue;
      const score = harnessTokens(`${type.typeId} ${type.name}`).filter((token) =>
        taskWords.some((word) => word.startsWith(token)),
      ).length;
      if (score > (best?.score ?? 0)) best = { type, categoryId: category.categoryId, score };
    }
  }
  if (best) {
    return {
      typeId: best.type.typeId,
      categoryId: best.categoryId,
      typeName: best.type.name,
      values: best.type.values,
      via: 'table',
    };
  }
  const fallback = resolveHarnessTypeSafeDefault(table);
  return {
    ...fallback,
    via: 'default',
  };
}

/** Palavras de 3+ letras, sem acento: "investigação/análise" → investigacao, analise. */
function harnessTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

/** Default declarado sem recursão — a linha `default` pode ter sido removida. */
function resolveHarnessTypeSafeDefault(table: HarnessTable): HarnessResolution {
  const needle = HARNESS_DEFAULT_TYPE_ID;
  for (const category of table.categories) {
    for (const type of category.types) {
      if (type.typeId === needle) {
        return {
          typeId: type.typeId,
          categoryId: category.categoryId,
          typeName: type.name,
          values: type.values,
          via: 'default',
        };
      }
    }
  }
  return {
    typeId: HARNESS_DEFAULT_TYPE_ID,
    categoryId: 'general',
    typeName: 'padrão (tipo sem linha)',
    values: { effort: 'medium' },
    via: 'default',
  };
}

export interface HarnessReceiptInput {
  readonly resolution: HarnessResolution;
  /** Overrides explícitos do chamador (vencem a tabela). */
  readonly explicit?: {
    cli?: string;
    model?: string;
    effort?: HarnessEffort;
    agent?: string;
  };
  /** Origem da classificação quando conhecida. */
  readonly classificationVia?: string;
  /** Quando o decisor (Jev) não decidiu, onde corrigir. */
  readonly decisorNote?: string;
  /** Origens de campos que NÃO vieram da tabela. */
  readonly originNotes?: readonly string[];
}

/**
 * Recibo OVKA-748 — três linhas fixas. `▸ decisor:` só quando o decisor não
 * decidiu; `▸ origens` só o que não veio da tabela.
 */
export function formatHarnessReceipt(input: HarnessReceiptInput): string {
  const { resolution, explicit } = input;
  const cli = explicit?.cli ?? resolution.values.cli ?? 'default';
  const model = explicit?.model ?? resolution.values.model ?? 'default';
  const effort = explicit?.effort ?? resolution.values.effort ?? 'medium';
  const skills = resolution.values.skills?.length
    ? `skills [${resolution.values.skills.join(', ')}]`
    : 'filtro=nenhum';
  const agent = resolution.values.agent ?? 'agente sem persona';
  const via = input.classificationVia ?? (resolution.via === 'default' ? 'default' : 'tabela do app');
  const category =
    resolution.categoryId;
  const lines = [
    `▸ harness: ${category} › ${resolution.typeName} (task=${resolution.typeId} · via=${via} · fonte=tabela do app, informativa: não decide CLI/modelo/esforço do spawn) · ${cli} · ${model} · ${effort} · ${skills} · ${agent}`,
  ];
  if (input.decisorNote) {
    lines.push(`▸ decisor: ${input.decisorNote}`);
  }
  if (input.originNotes?.length) {
    lines.push(`▸ origens: ${input.originNotes.join(' · ')}`);
  }
  return lines.join('\n');
}

/**
 * Gate de skill OVKA-713 — ausência de filtro LIBERTA; filtro declarado é
 * whitelist dura (exatamente o declarado).
 */
export function isSkillAllowedByHarness(
  values: HarnessTypeValues | undefined,
  skillName: string,
): { allowed: boolean; filter: 'none' | 'declared'; reason?: string } {
  const declared = values?.skills;
  if (!declared || declared.length === 0) {
    return { allowed: true, filter: 'none' };
  }
  if (declared.includes(skillName)) {
    return { allowed: true, filter: 'declared' };
  }
  return {
    allowed: false,
    filter: 'declared',
    reason:
      `skill '${skillName}' fora do filtro do harness (declarado: ${declared.join(', ')}); ` +
      'linha sem skill = sem filtro',
  };
}
