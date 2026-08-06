import { parseDocument, type Document } from 'yaml';
import { z } from 'zod';
import { isToolAllowed } from './gate';

const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_COMPATIBILITY_LENGTH = 500;

const skillMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_SKILL_NAME_LENGTH)
      .regex(SKILL_NAME),
    description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH),
    license: z.string().optional(),
    compatibility: z
      .string()
      .min(1)
      .max(MAX_COMPATIBILITY_LENGTH)
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'allowed-tools': z.string().optional(),
  })
  .strict();

export interface AgentPluginSkill {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly declaredAllowedTools?: string;
  /** Package metadata can describe tools, never authorize them. */
  readonly allowedToolsHonored: false;
  readonly permissionGate: 'PreToolUse';
  readonly body: string;
}

export type AgentPluginSkillVerdict =
  | { readonly ok: true; readonly skill: AgentPluginSkill }
  | { readonly ok: false; readonly reason: string };

export interface AgentPluginToolReduction {
  readonly requested: readonly string[];
  readonly granted: readonly string[];
  readonly removed: readonly string[];
  readonly wasReduced: boolean;
  readonly notice: string | null;
}

interface ParsedFrontmatter {
  readonly document: Document.Parsed;
  readonly data: unknown;
  readonly body: string;
}

function splitFrontmatter(content: string):
  | { ok: true; value: ParsedFrontmatter }
  | { ok: false; reason: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { ok: false, reason: 'SKILL.md sem frontmatter YAML inicial' };
  }
  const closing = lines.findIndex(
    (line, index) => index > 0 && (line === '---' || line === '...'),
  );
  if (closing < 0) {
    return { ok: false, reason: 'frontmatter YAML sem delimitador final' };
  }

  const yaml = lines.slice(1, closing).join('\n');
  const document = parseDocument(yaml, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return {
      ok: false,
      reason: `frontmatter YAML inválido: ${document.errors[0]?.message ?? 'erro de parse'}`,
    };
  }
  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    return {
      ok: false,
      reason: `frontmatter YAML inválido: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ok: true,
    value: {
      document,
      data,
      body: lines.slice(closing + 1).join('\n'),
    },
  };
}

function zodReason(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'frontmatter fora da especificação Agent Skills';
  const field = issue.path.length > 0 ? issue.path.join('.') : 'frontmatter';
  return `${field}: ${issue.message}`;
}

export function readAgentPluginSkill(input: {
  readonly directoryName: string;
  readonly content: string;
}): AgentPluginSkillVerdict {
  const frontmatter = splitFrontmatter(input.content);
  if (!frontmatter.ok) return frontmatter;
  const parsed = skillMetadataSchema.safeParse(frontmatter.value.data);
  if (!parsed.success) {
    return { ok: false, reason: zodReason(parsed.error) };
  }
  if (parsed.data.name !== input.directoryName) {
    return {
      ok: false,
      reason:
        `nome da skill "${parsed.data.name}" não corresponde ao diretório ` +
        `"${input.directoryName}"`,
    };
  }

  return Object.freeze({
    ok: true,
    skill: Object.freeze({
      name: parsed.data.name,
      description: parsed.data.description,
      ...(parsed.data.license !== undefined
        ? { license: parsed.data.license }
        : {}),
      ...(parsed.data.compatibility !== undefined
        ? { compatibility: parsed.data.compatibility }
        : {}),
      ...(parsed.data.metadata !== undefined
        ? { metadata: Object.freeze({ ...parsed.data.metadata }) }
        : {}),
      ...(parsed.data['allowed-tools'] !== undefined
        ? { declaredAllowedTools: parsed.data['allowed-tools'] }
        : {}),
      allowedToolsHonored: false as const,
      permissionGate: 'PreToolUse' as const,
      body: frontmatter.value.body,
    }),
  });
}

function gateToolName(requested: string): string | null {
  const lower = requested.toLowerCase();
  if (lower.startsWith('mcp__nexus__')) {
    return requested.slice('mcp__nexus__'.length);
  }
  return lower.startsWith('nexus_') ? requested : null;
}

/**
 * Agent Skills calls `allowed-tools` pre-approved. A package may request that
 * convenience, but only Nexus MCP tools already allowed by the main-owned gate
 * survive. Native/provider and foreign-MCP names are always removed because a
 * skill file cannot prove the user's native sandbox policy.
 */
export function reduceAgentPluginAllowedTools(
  declaration: string | undefined,
  allowedTools: readonly string[] | null,
): AgentPluginToolReduction {
  const requested = [
    ...new Set((declaration ?? '').split(/\s+/).map((tool) => tool.trim()).filter(Boolean)),
  ];
  const granted = requested.filter((tool) => {
    const gateName = gateToolName(tool);
    return gateName !== null && isToolAllowed(allowedTools ? [...allowedTools] : null, gateName);
  });
  const grantedSet = new Set(granted);
  const removed = requested.filter((tool) => !grantedSet.has(tool));
  return Object.freeze({
    requested: Object.freeze(requested),
    granted: Object.freeze(granted),
    removed: Object.freeze(removed),
    wasReduced: removed.length > 0,
    notice:
      removed.length > 0
        ? `${removed.length} solicitação(ões) de allowed-tools removida(s) pelo gate Nexus: ${removed.join(', ')}`
        : null,
  });
}

/**
 * Provider-native `allowed-tools` can bypass prompts. Nexus strips it from the
 * session copy so the existing synchronous PreToolUse decision remains the
 * sole authority boundary.
 */
export function stripAgentPluginAllowedTools(
  content: string,
  allowedTools: readonly string[] | null = [],
): string {
  const parsed = splitFrontmatter(content);
  if (!parsed.ok) throw new Error(parsed.reason);
  const raw = parsed.value.document.get('allowed-tools');
  const reduction = reduceAgentPluginAllowedTools(
    typeof raw === 'string' ? raw : undefined,
    allowedTools,
  );
  if (reduction.granted.length > 0) {
    parsed.value.document.set('allowed-tools', reduction.granted.join(' '));
  } else {
    parsed.value.document.delete('allowed-tools');
  }
  const yaml = parsed.value.document.toString().trimEnd();
  return `---\n${yaml}\n---\n${parsed.value.body}`;
}
