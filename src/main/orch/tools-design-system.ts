import { createHash } from 'node:crypto';
import path from 'node:path';
import type { McpToolDef } from './mcp-protocol';
import type { AgentGateContext } from './gate';
import type { ProjectExecutionScope } from '../../shared/types';
import { getContextKnowledgeService } from '../context/context-workflow-registry';
import type { ContextAttestationSource } from '../context/context-attestation';
import {
  DesignMdApiClient,
  DesignMdApiError,
  DesignMdAuthError,
  DesignMdLicenseError,
} from '../design/designmd-api-client';
import { requireStr, str, strArray, num } from './tool-util';
import {
  ensureWorkspaceDirectory,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from './workspace-file';

/**
 * MCP tools for importing design systems from designmd.ai into the Nexus
 * context authority pipeline. These tools never write the final DESIGN.md
 * directly; imports are recorded as proposed ContextDrafts that require
 * independent review before application.
 *
 * Authentication uses the encrypted vault key `external:designmd-api-key`.
 * The API key is never exposed to subprocess environment variables.
 */

const EVIDENCE_DIR = '.context/nexus/evidence/designmd-ai';
const DEFAULT_TARGET_PATH = '.context/docs/design-system.md';
const SORT_OPTIONS = new Set(['popular', 'recent', 'likes', 'downloads']);

function missionIdentity(ctx: AgentGateContext) {
  if (!ctx.sessionId) throw new Error('design system action requires a bound agent session');
  return {
    id: ctx.agentName ?? ctx.label,
    sessionId: ctx.sessionId,
    provider: ctx.providerId ?? ctx.label,
  };
}

function assertMission(ctx: AgentGateContext, requested: string): void {
  if (ctx.missionId && ctx.missionId !== requested) {
    throw new Error('not authorized: mission differs from session mission');
  }
  if (!ctx.missionId && ctx.role !== 'user') {
    throw new Error('not authorized: agent session is not bound to a mission');
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function expectedTargetHash(
  ctx: AgentGateContext,
  targetPath: string,
): string | null {
  try {
    return sha256(readWorkspaceTextFile(ctx.scope, targetPath).content);
  } catch (error) {
    if (error instanceof Error && /file not found:/i.test(error.message)) return null;
    throw error;
  }
}

function sanitizeIdentifier(raw: string): string {
  // Collapse slashes and non-portable characters so the evidence filename is
  // safe and deterministic, while keeping it human-readable.
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/https:\/\/designmd\.ai\//g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) return 'unknown';
  return normalized.slice(0, 128);
}

function evidencePath(identifierValue: string): string {
  return `${EVIDENCE_DIR}/${sanitizeIdentifier(identifierValue)}.json`;
}

function deriveSlug(scope: ProjectExecutionScope, targetPath: string): string {
  const base = path.posix.basename(targetPath, path.posix.extname(targetPath));
  const sanitized = scope.projectId.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `${sanitized || 'project'}/${base || 'design-system'}`;
}

function deriveName(targetPath: string): string {
  const base = path.posix.basename(targetPath, path.posix.extname(targetPath));
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseDesignMdFrontmatter(content: string): {
  name?: string;
  slug?: string;
  description?: string;
  tags?: string[];
  license?: string;
} {
  const normalized = content.replace(/\r\n/g, '\n');
  const trimmed = normalized.trimStart();
  if (!trimmed.startsWith('---\n')) return {};
  const end = trimmed.indexOf('\n---', 4);
  if (end === -1) return {};
  const frontmatter = trimmed.slice(4, end);
  const result: ReturnType<typeof parseDesignMdFrontmatter> = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^(name|slug|description|license):\s*(.*)$/);
    if (match) {
      const key = match[1] as 'name' | 'slug' | 'description' | 'license';
      result[key] = match[2].trim();
    }
    const tagsMatch = line.match(/^tags:\s*\[(.*)\]$/);
    if (tagsMatch) {
      result.tags = tagsMatch[1].split(',').map((tag) => tag.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
  }
  return result;
}

function prefixedDesignMdContent(
  kit: { name: string; author: string; url: string; license: string; slug: string },
  content: string,
): string {
  return [
    '<!-- DESIGN.md imported from designmd.ai -->',
    `<!-- source: ${kit.url} -->`,
    `<!-- slug: ${kit.slug} | author: ${kit.author} | license: ${kit.license} -->`,
    '<!-- This file is a PROPOSED context draft. Do not apply without review. -->',
    '',
    content,
  ].join('\n');
}

async function writeEvidence(
  ctx: AgentGateContext,
  identifierValue: string,
  kit: { name: string; author: string; url: string; license: string; slug: string; content: string },
): Promise<ContextAttestationSource> {
  const relativePath = evidencePath(identifierValue);
  ensureWorkspaceDirectory(ctx.scope, EVIDENCE_DIR);
  const evidence = {
    schemaVersion: 1,
    source: 'designmd.ai',
    importedAt: new Date().toISOString(),
    ...kit,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  writeWorkspaceTextFile(ctx.scope, relativePath, json);
  return {
    type: 'connector',
    locator: relativePath,
    sourceHash: sha256(json),
  };
}

function createDesignMdApiClient(): DesignMdApiClient {
  return new DesignMdApiClient();
}

const designSystemSearchTool: McpToolDef = {
  name: 'nexus_design_system_search',
  description:
    'Search public design systems on designmd.ai. No API key is required. ' +
    'Returns a list of kits with metadata (name, author, tags, license, popularity).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text search query' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
      sort: {
        type: 'string',
        enum: ['popular', 'recent', 'likes', 'downloads'],
        description: 'Result ordering',
      },
      limit: { type: 'number', description: 'Maximum results (default: 20)' },
    },
  },
  handler: async (args, _ctx) => {
    const query = str(args, 'query');
    const tags = strArray(args, 'tags');
    const rawSort = str(args, 'sort');
    const sort = rawSort && SORT_OPTIONS.has(rawSort)
      ? (rawSort as 'popular' | 'recent' | 'likes' | 'downloads')
      : undefined;
    const limit = num(args, 'limit');
    const client = createDesignMdApiClient();
    const results = await client.searchKits({
      ...(query ? { query } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(sort ? { sort } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return {
      count: results.length,
      kits: results.map((kit) => ({
        slug: kit.slug,
        name: kit.name,
        description: kit.description,
        author: kit.author,
        url: kit.url,
        tags: kit.tags,
        license: kit.license,
        downloadCount: kit.downloadCount,
        likeCount: kit.likeCount,
      })),
    };
  },
};

const designSystemGetTool: McpToolDef = {
  name: 'nexus_design_system_get',
  description:
    'Fetch the full DESIGN.md content of a design system from designmd.ai. ' +
    'Requires the `external:designmd-api-key` secret to be stored in Nexus.',
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'Kit identifier (`author/slug`) or full designmd.ai URL',
      },
    },
    required: ['identifier'],
  },
  handler: async (args, _ctx) => {
    const identifierValue = requireStr(args, 'identifier');
    const kit = await createDesignMdApiClient().getKit(identifierValue);
    return {
      slug: kit.slug,
      name: kit.name,
      description: kit.description,
      author: kit.author,
      url: kit.url,
      tags: kit.tags,
      license: kit.license,
      downloadCount: kit.downloadCount,
      likeCount: kit.likeCount,
      content: kit.content,
    };
  },
};

const designSystemImportTool: McpToolDef = {
  name: 'nexus_design_system_import',
  description:
    'Import a DESIGN.md from designmd.ai as a proposed ContextDraft. ' +
    'The draft is placed at `.context/docs/design-system.md` (configurable) and ' +
    'must be independently reviewed before application. ' +
    'Requires the `external:designmd-api-key` secret.',
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'Kit identifier (`author/slug`) or full designmd.ai URL',
      },
      targetPath: {
        type: 'string',
        description: 'Workspace-relative authority path for the DESIGN.md (default: .context/docs/design-system.md)',
      },
      missionId: {
        type: 'string',
        description: 'Mission binding; defaults to the caller mission',
      },
    },
    required: ['identifier'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') {
      throw new Error('workers cannot propose context authority drafts');
    }
    const identifierValue = requireStr(args, 'identifier');
    const targetPath = str(args, 'targetPath') ?? DEFAULT_TARGET_PATH;
    const requestedMissionId = str(args, 'missionId');
    const missionId = requestedMissionId ?? ctx.missionId;
    if (missionId) assertMission(ctx, missionId);

    const kit = await createDesignMdApiClient().getKit(identifierValue);

    if (kit.license === 'cc-by-sa') {
      throw new DesignMdLicenseError(
        kit.license,
        `license ${kit.license} requires project compatibility review; import blocked by default`,
      );
    }

    const source = await writeEvidence(ctx, identifierValue, {
      name: kit.name,
      author: kit.author,
      url: kit.url,
      license: kit.license,
      slug: kit.slug,
      content: kit.content,
    });

    const content = prefixedDesignMdContent(
      {
        name: kit.name,
        author: kit.author,
        url: kit.url,
        license: kit.license,
        slug: kit.slug,
      },
      kit.content,
    );

    const draft = getContextKnowledgeService(ctx.scope).propose({
      missionId,
      targetPath,
      content,
      expectedTargetHash: expectedTargetHash(ctx, targetPath),
      sources: [source],
    }, missionIdentity(ctx));

    return {
      draftId: draft.id,
      targetPath: draft.targetPath,
      status: draft.status,
      evidencePath: source.locator,
    };
  },
};

const designSystemPublishTool: McpToolDef = {
  name: 'nexus_design_system_publish',
  description:
    'Publish the canonical DESIGN.md from the workspace to designmd.ai. ' +
    'Requires the `external:designmd-api-key` secret. Only orchestrators and ' +
    'the user can publish.',
  inputSchema: {
    type: 'object',
    properties: {
      targetPath: {
        type: 'string',
        description: 'Workspace-relative path to the DESIGN.md (default: .context/docs/design-system.md)',
      },
      slug: {
        type: 'string',
        description: 'Kit slug (`author/slug`); defaults to `<project>/design-system`',
      },
      name: { type: 'string', description: 'Kit name; defaults to the target file name' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      license: {
        type: 'string',
        enum: ['mit', 'cc0', 'cc-by', 'cc-by-sa'],
        description: 'License; defaults to mit',
      },
    },
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') {
      throw new Error('workers cannot publish design systems');
    }
    const targetPath = str(args, 'targetPath') ?? DEFAULT_TARGET_PATH;
    const file = readWorkspaceTextFile(ctx.scope, targetPath);
    const frontmatter = parseDesignMdFrontmatter(file.content);
    const slug = str(args, 'slug') ?? frontmatter.slug ?? deriveSlug(ctx.scope, targetPath);
    const name = str(args, 'name') ?? frontmatter.name ?? deriveName(targetPath);
    const description = str(args, 'description') ?? frontmatter.description ?? '';
    const requestedTags = strArray(args, 'tags');
    const tags = requestedTags.length > 0 ? requestedTags : (frontmatter.tags ?? []);
    const license = str(args, 'license') ?? frontmatter.license ?? 'mit';

    const published = await createDesignMdApiClient().publishKit({
      slug,
      name,
      description,
      tags,
      license,
      content: file.content,
    });

    return {
      slug: published.slug,
      name: published.name,
      url: published.url,
      license: published.license,
    };
  },
};

export function buildDesignSystemTools(): McpToolDef[] {
  return [
    designSystemSearchTool,
    designSystemGetTool,
    designSystemImportTool,
    designSystemPublishTool,
  ];
}

// Re-export error classes so the toolset and tests can distinguish them.
export { DesignMdApiError, DesignMdAuthError, DesignMdLicenseError };
