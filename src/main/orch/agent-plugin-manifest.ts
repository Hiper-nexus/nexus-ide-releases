import { z } from 'zod';

/** Agent Plugins is schema-selected. Compatibility is exact until reviewed. */
export const SUPPORTED_PLUGIN_SPEC = '1.0.0' as const;
export const PLUGIN_MANIFEST_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' as const;
export const MCP_MANIFEST_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' as const;

/** v1 has exactly these two portable component types, both file-discovered. */
export const SUPPORTED_COMPONENTS = Object.freeze([
  'skills',
  'mcpServers',
] as const);

export type SupportedComponent = (typeof SUPPORTED_COMPONENTS)[number];

export interface PluginIngestionNotice {
  readonly component: string;
  readonly why: string;
}

/** Kept for the inventory contract; v1 never declares entries inline. */
export interface PluginComponentEntry {
  readonly component: SupportedComponent;
  readonly name: string;
}

export interface AcceptedPlugin {
  readonly ok: true;
  readonly specVersion: typeof SUPPORTED_PLUGIN_SPEC;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: Readonly<{
    name?: string;
    email?: string;
    url?: string;
  }>;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords: readonly string[];
  readonly extensionNamespaces: readonly string[];
  /** Always empty: components come from fixed filesystem locations. */
  readonly entries: readonly PluginComponentEntry[];
  /** Non-fatal exceptions required by §5.2 and §8.1. */
  readonly degraded: readonly PluginIngestionNotice[];
}

export interface RejectedPlugin {
  readonly ok: false;
  readonly reason: string;
}

export type PluginManifestVerdict = AcceptedPlugin | RejectedPlugin;

const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const authorSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

const manifestCoreSchema = z
  .object({
    $schema: z.literal(PLUGIN_MANIFEST_SCHEMA),
    name: z.string().min(1).max(64).regex(PLUGIN_NAME),
    version: z.string().optional(),
    description: z.string().optional(),
    author: authorSchema.optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  })
  .strict();

const CORE_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]);
const MANIFEST_FIELDS = new Set([...CORE_FIELDS, 'extensions']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaVersion(schema: string): string {
  return /\/schemas\/([^/]+)\/plugin\.schema\.json$/.exec(schema)?.[1] ?? schema;
}

function issueReason(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'manifesto fora do schema v1.0.0';
  const field = issue.path.length > 0 ? issue.path.join('.') : 'plugin.json';
  return `campo "${field}" inválido para Agent Plugins v1.0.0: ${issue.message}`;
}

/**
 * Validate plugin.json using the locally pinned v1.0.0 rules. No schema is
 * fetched at load time. Unknown root fields and non-object extensions are the
 * two explicit non-fatal exceptions in the normative specification.
 */
export function readPluginManifest(raw: unknown): PluginManifestVerdict {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'manifesto não é um objeto JSON' };
  }

  if (!Object.hasOwn(raw, '$schema')) {
    return {
      ok: false,
      reason: `manifesto sem "$schema"; este Nexus exige ${PLUGIN_MANIFEST_SCHEMA}`,
    };
  }
  if (raw.$schema !== PLUGIN_MANIFEST_SCHEMA) {
    const requested =
      typeof raw.$schema === 'string' ? schemaVersion(raw.$schema) : typeof raw.$schema;
    return {
      ok: false,
      reason:
        `plugin exige Agent Plugins ${requested}; este Nexus fixa ` +
        `${SUPPORTED_PLUGIN_SPEC} (${PLUGIN_MANIFEST_SCHEMA})`,
    };
  }

  const core = Object.fromEntries(
    Object.entries(raw).filter(([key]) => CORE_FIELDS.has(key)),
  );
  const parsed = manifestCoreSchema.safeParse(core);
  if (!parsed.success) {
    return { ok: false, reason: issueReason(parsed.error) };
  }

  const degraded: PluginIngestionNotice[] = [];
  for (const key of Object.keys(raw)) {
    if (MANIFEST_FIELDS.has(key)) continue;
    degraded.push({
      component: key,
      why: 'campo raiz desconhecido ignorado; componentes v1 usam locais fixos',
    });
  }

  const extensionNamespaces: string[] = [];
  if (Object.hasOwn(raw, 'extensions')) {
    if (!isRecord(raw.extensions)) {
      degraded.push({
        component: 'extensions',
        why: 'campo não é objeto; ignorado conforme Agent Plugins v1.0.0 §8.1',
      });
    } else {
      for (const namespace of Object.keys(raw.extensions)) {
        extensionNamespaces.push(namespace);
        degraded.push({
          component: `extensions.${namespace}`,
          why: 'namespace de extensão não implementado pelo Nexus; conteúdo não validado',
        });
      }
    }
  }

  return Object.freeze({
    ok: true,
    specVersion: SUPPORTED_PLUGIN_SPEC,
    name: parsed.data.name,
    version: parsed.data.version ?? '',
    description: parsed.data.description ?? '',
    ...(parsed.data.author ? { author: Object.freeze(parsed.data.author) } : {}),
    ...(parsed.data.homepage !== undefined
      ? { homepage: parsed.data.homepage }
      : {}),
    ...(parsed.data.repository !== undefined
      ? { repository: parsed.data.repository }
      : {}),
    ...(parsed.data.license !== undefined ? { license: parsed.data.license } : {}),
    keywords: Object.freeze([...(parsed.data.keywords ?? [])]),
    extensionNamespaces: Object.freeze(extensionNamespaces),
    entries: Object.freeze([]),
    degraded: Object.freeze(degraded),
  });
}

export function describePluginIngestion(verdict: PluginManifestVerdict): string {
  if (!verdict.ok) return `Plugin recusado: ${verdict.reason}`;
  const version = verdict.version || 'sem versão declarada';
  const base = `${verdict.name} ${version}: manifesto Agent Plugins ${verdict.specVersion} válido`;
  if (verdict.degraded.length === 0) return base;
  const ignored = verdict.degraded.map((notice) => notice.component).join(', ');
  return `${base} — ignorado: ${ignored}`;
}
