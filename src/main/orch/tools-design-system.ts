import path from 'node:path';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
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
import {
  DembrandtExtractError,
  extractDesignSystemFromUrl,
} from '../design/dembrandt-extractor';
import {
  renderDesignContract,
  sanitizeDesignCommentValue,
} from '../design/design-kit-source';
import {
  DEFAULT_DESIGN_TARGET_PATH,
  assertDesignSystemAuthority,
  assertMission,
  designSha256 as sha256,
  expectedTargetHash,
  missionIdentity,
  sanitizeIdentifier,
  type DesignSystemToolOptions,
} from './design-system-authority';
import { buildKeylessDesignSystemTools } from './tools-design-system-local';
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
const DEMBRANDT_EVIDENCE_DIR = '.context/nexus/evidence/dembrandt';
const DEFAULT_TARGET_PATH = DEFAULT_DESIGN_TARGET_PATH;
const SORT_OPTIONS = new Set(['popular', 'recent', 'likes', 'downloads']);

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
  // Same renderer as the keyless catalog sources: one provenance format, and
  // the source that produced the contract is always named.
  return renderDesignContract({
    marker: 'DESIGN.md imported from designmd.ai',
    sourceId: 'designmd.ai',
    kitId: kit.slug,
    details: [
      `source: ${kit.url}`,
      `slug: ${kit.slug} | author: ${kit.author} | license: ${kit.license}`,
    ],
    content,
  });
}

const sanitizeHtmlCommentValue = sanitizeDesignCommentValue;

function prefixedDembrandtDesignMdContent(
  meta: { sourceUrl: string; normalizedUrl: string },
  content: string,
): string {
  const source = sanitizeHtmlCommentValue(meta.normalizedUrl);
  const requested = sanitizeHtmlCommentValue(meta.sourceUrl);
  return [
    '<!-- DESIGN.md extracted by Dembrandt from a live URL -->',
    `<!-- source: ${source} -->`,
    `<!-- requested: ${requested} -->`,
    '<!-- UNTRUSTED until independently reviewed and applied. Do not copy logos or trademarks. -->',
    '<!-- This file is a PROPOSED context draft. Do not apply without review. -->',
    '',
    content,
  ].join('\n');
}

function writeEvidence(
  ctx: AgentGateContext,
  identifierValue: string,
  kit: { name: string; author: string; url: string; license: string; slug: string; content: string },
  assertCurrentAuthority: () => void,
): ContextAttestationSource {
  const relativePath = evidencePath(identifierValue);
  assertCurrentAuthority();
  ensureWorkspaceDirectory(ctx.scope, EVIDENCE_DIR);
  const evidence = {
    schemaVersion: 1,
    source: 'designmd.ai',
    importedAt: new Date().toISOString(),
    ...kit,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  assertCurrentAuthority();
  writeWorkspaceTextFile(ctx.scope, relativePath, json);
  assertCurrentAuthority();
  return {
    type: 'connector',
    locator: relativePath,
    sourceHash: sha256(json),
  };
}

function writeDembrandtEvidence(
  ctx: AgentGateContext,
  meta: {
    sourceUrl: string;
    normalizedUrl: string;
    content: string;
    darkMode: boolean;
    mobile: boolean;
    wcag: boolean;
    paths: readonly string[];
  },
  assertCurrentAuthority: () => void,
): ContextAttestationSource {
  const relativePath = `${DEMBRANDT_EVIDENCE_DIR}/${sanitizeIdentifier(meta.normalizedUrl)}.json`;
  assertCurrentAuthority();
  ensureWorkspaceDirectory(ctx.scope, DEMBRANDT_EVIDENCE_DIR);
  const contentHash = sha256(meta.content);
  const evidence = {
    schemaVersion: 1,
    source: 'dembrandt',
    extractedAt: new Date().toISOString(),
    sourceUrl: sanitizeHtmlCommentValue(meta.sourceUrl),
    normalizedUrl: sanitizeHtmlCommentValue(meta.normalizedUrl),
    darkMode: meta.darkMode,
    mobile: meta.mobile,
    wcag: meta.wcag,
    paths: [...meta.paths],
    contentBytes: Buffer.byteLength(meta.content, 'utf8'),
    contentHash,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  assertCurrentAuthority();
  writeWorkspaceTextFile(ctx.scope, relativePath, json);
  assertCurrentAuthority();
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

function designSystemImportTool(
  options: DesignSystemToolOptions,
): McpToolDef {
  return {
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
  handler: async (args, ctx, invocation) => {
    const assertCurrentAuthority = (): void => {
      assertMcpInvocationCurrent(invocation);
      assertDesignSystemAuthority(ctx, options);
    };
    assertCurrentAuthority();
    if (ctx.role === 'worker') {
      throw new Error('workers cannot propose context authority drafts');
    }
    const identifierValue = requireStr(args, 'identifier');
    const targetPath = str(args, 'targetPath') ?? DEFAULT_TARGET_PATH;
    const requestedMissionId = str(args, 'missionId');
    const missionId = requestedMissionId ?? ctx.missionId;
    if (missionId) assertMission(ctx, missionId);

    const kit = await createDesignMdApiClient().getKit(identifierValue);
    assertCurrentAuthority();

    if (kit.license === 'cc-by-sa' || kit.license === 'proprietary') {
      throw new DesignMdLicenseError(
        kit.license,
        `license ${kit.license} requires project compatibility review; import blocked by default`,
      );
    }

    const source = writeEvidence(ctx, identifierValue, {
      name: kit.name,
      author: kit.author,
      url: kit.url,
      license: kit.license,
      slug: kit.slug,
      content: kit.content,
    }, assertCurrentAuthority);

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

    assertCurrentAuthority();
    const draft = getContextKnowledgeService(ctx.scope).propose({
      missionId,
      targetPath,
      content,
      expectedTargetHash: expectedTargetHash(ctx, targetPath),
      sources: [source],
    }, missionIdentity(ctx));
    assertCurrentAuthority();

    return {
      draftId: draft.id,
      targetPath: draft.targetPath,
      status: draft.status,
      evidencePath: source.locator,
    };
  },
  };
}

function designSystemExtractTool(
  options: DesignSystemToolOptions,
): McpToolDef {
  return {
    name: 'nexus_design_system_extract',
    description:
      'Propose a ContextDraft from a live website through a per-request guarded Dembrandt runner. ' +
      'Fails closed with NETWORK_GUARD_UNAVAILABLE while no redirect/subresource route guard is ' +
      'installed. Use designmd.ai search/import or an existing DESIGN.md instead; never writes ' +
      'the final DESIGN.md directly. Do not copy third-party logos.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Public http(s) URL (or host) to extract design tokens from',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra paths to merge (e.g. /pricing, /docs)',
        },
        darkMode: {
          type: 'boolean',
          description: 'Extract dark-mode variant colors when available',
        },
        mobile: {
          type: 'boolean',
          description: 'Use mobile viewport (390x844) for extraction',
        },
        wcag: {
          type: 'boolean',
          description: 'Include WCAG contrast analysis in the Dembrandt run',
        },
        targetPath: {
          type: 'string',
          description:
            'Workspace-relative authority path (default: .context/docs/design-system.md)',
        },
        missionId: {
          type: 'string',
          description: 'Mission binding; defaults to the caller mission',
        },
      },
      required: ['url'],
    },
    handler: async (args, ctx, invocation) => {
      const assertCurrentAuthority = (): void => {
        assertMcpInvocationCurrent(invocation);
        assertDesignSystemAuthority(ctx, options);
      };
      assertCurrentAuthority();
      if (ctx.role === 'worker') {
        throw new Error('workers cannot propose context authority drafts');
      }
      const url = requireStr(args, 'url');
      const paths = strArray(args, 'paths');
      const darkMode = args.darkMode === true;
      const mobile = args.mobile === true;
      const wcag = args.wcag === true;
      const targetPath = str(args, 'targetPath') ?? DEFAULT_TARGET_PATH;
      const requestedMissionId = str(args, 'missionId');
      const missionId = requestedMissionId ?? ctx.missionId;
      if (missionId) assertMission(ctx, missionId);

      let extracted;
      try {
        extracted = await extractDesignSystemFromUrl({
          url,
          paths,
          darkMode,
          mobile,
          wcag,
          signal: invocation?.signal,
          ...(options.routeGuardedExtractDesignSystem
            ? {
                routeGuardedRunner:
                  options.routeGuardedExtractDesignSystem,
              }
            : {}),
          ...(options.assessExtractUrl
            ? { assessUrl: options.assessExtractUrl }
            : {}),
        });
      } catch (error) {
        if (error instanceof DembrandtExtractError) {
          throw new Error(`dembrandt extract failed (${error.code}): ${error.message}`);
        }
        throw error;
      }
      assertCurrentAuthority();

      const source = writeDembrandtEvidence(
        ctx,
        {
          sourceUrl: extracted.sourceUrl,
          normalizedUrl: extracted.normalizedUrl,
          content: extracted.designMd,
          darkMode,
          mobile,
          wcag,
          paths,
        },
        assertCurrentAuthority,
      );

      const content = prefixedDembrandtDesignMdContent(
        {
          sourceUrl: extracted.sourceUrl,
          normalizedUrl: extracted.normalizedUrl,
        },
        extracted.designMd,
      );

      assertCurrentAuthority();
      const draft = getContextKnowledgeService(ctx.scope).propose(
        {
          missionId,
          targetPath,
          content,
          expectedTargetHash: expectedTargetHash(ctx, targetPath),
          sources: [source],
        },
        missionIdentity(ctx),
      );
      assertCurrentAuthority();

      return {
        draftId: draft.id,
        targetPath: draft.targetPath,
        status: draft.status,
        evidencePath: source.locator,
        sourceUrl: extracted.sourceUrl,
        normalizedUrl: extracted.normalizedUrl,
      };
    },
  };
}

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
  handler: async (args, ctx, invocation) => {
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

    assertMcpInvocationCurrent(invocation);
    const publishInput = {
      slug,
      name,
      description,
      tags,
      license,
      content: file.content,
    };
    const client = createDesignMdApiClient();
    const published = invocation?.signal
      ? await client.publishKit(publishInput, { signal: invocation.signal })
      : await client.publishKit(publishInput);
    assertMcpInvocationCurrent(invocation);

    return {
      slug: published.slug,
      name: published.name,
      url: published.url,
      license: published.license,
    };
  },
};

export function buildDesignSystemTools(
  options: DesignSystemToolOptions = {},
): McpToolDef[] {
  return [
    designSystemSearchTool,
    designSystemGetTool,
    designSystemImportTool(options),
    designSystemExtractTool(options),
    designSystemPublishTool,
    // Keyless sources (local catalog + open getdesign catalog). They carry the
    // same authority guards and exist so a missing designmd.ai key never leaves
    // a project without a design contract.
    ...buildKeylessDesignSystemTools(options),
  ];
}

// Re-export error classes so the toolset and tests can distinguish them.
export { DesignMdApiError, DesignMdAuthError, DesignMdLicenseError, DembrandtExtractError };
export type { DesignSystemToolOptions };
