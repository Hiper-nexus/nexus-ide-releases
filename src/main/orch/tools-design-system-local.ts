import {
  assertMcpInvocationCurrent,
  type McpToolDef,
} from './mcp-protocol';
import type { AgentGateContext } from './gate';
import { getContextKnowledgeService } from '../context/context-workflow-registry';
import type { ContextAttestationSource } from '../context/context-attestation';
import {
  renderDesignContract,
  type DesignKit,
  type DesignKitSource,
  type DesignKitSourceId,
} from '../design/design-kit-source';
import {
  createLocalDesignKitSource,
  listLocalDesignCatalog,
  resolveLocalDesignCatalogDir,
} from '../design/local-design-catalog';
import {
  createGetDesignKitSource,
  listGetDesignKits,
} from '../design/getdesign-cli-source';
import { getOrchSettings } from '../persistence/settings-store';
import {
  DEFAULT_DESIGN_TARGET_PATH,
  assertDesignSystemAuthority,
  assertMission,
  designSha256,
  expectedTargetHash,
  findExistingDesignContract,
  missionIdentity,
  sanitizeIdentifier,
  type DesignSystemToolOptions,
} from './design-system-authority';
import { homeRelativePath } from './home-relative-path';
import { requireStr, str } from './tool-util';
import {
  ensureWorkspaceDirectory,
  writeWorkspaceTextFile,
} from './workspace-file';

/**
 * Keyless design-contract tools.
 *
 * `nexus_design_system_import` can only serve a kit when
 * `external:designmd-api-key` is in the vault — designmd.ai answers 401 on the
 * `/raw` body endpoint otherwise, MIT license or not. These tools cover the two
 * sources that need no credential at all, so a project is never built without a
 * design contract just because no key was configured:
 *
 * - `local-catalog`: `~/.design-references/*.md` (configurable via
 *   `orch.designLocalCatalogDir`). Offline, instant.
 * - `getdesign`: the open `getdesign` CLI catalog, sandboxed per
 *   src/main/design/getdesign-cli-source.ts.
 *
 * Both go through the same ContextDraft flow as every other source: this never
 * writes the final DESIGN.md, and workers may not propose drafts.
 */

const EVIDENCE_DIR = '.context/nexus/evidence/design-catalog';
const KEYLESS_SOURCES: readonly DesignKitSourceId[] = ['local-catalog', 'getdesign'];

function parseSourceId(raw: string | undefined): DesignKitSourceId {
  const value = (raw ?? 'local-catalog').trim();
  const found = KEYLESS_SOURCES.find((candidate) => candidate === value);
  if (!found) {
    throw new Error(
      `unknown keyless design kit source: ${value.slice(0, 64)} ` +
        `(expected one of ${KEYLESS_SOURCES.join(', ')})`,
    );
  }
  return found;
}

function catalogDir(options: DesignSystemToolOptions): string {
  if (options.localDesignCatalogDir !== undefined) {
    return resolveLocalDesignCatalogDir(options.localDesignCatalogDir);
  }
  // Settings must never be the reason the fallback source is unavailable.
  try {
    return resolveLocalDesignCatalogDir(getOrchSettings().designLocalCatalogDir);
  } catch {
    return resolveLocalDesignCatalogDir();
  }
}

/**
 * Resolve one keyless source. Exported because the renderer import path needs
 * the same construction rules (settings-derived catalog dir, injected CLI
 * runner) when it falls back from designmd.ai.
 */
export function keylessDesignKitSource(
  sourceId: DesignKitSourceId,
  options: DesignSystemToolOptions = {},
): DesignKitSource {
  if (sourceId === 'getdesign') {
    return createGetDesignKitSource(options.getDesignSourceOptions ?? {});
  }
  return createLocalDesignKitSource({ dir: catalogDir(options) });
}

function assertNotWorker(ctx: AgentGateContext, action: string): void {
  if (ctx.role !== 'worker') return;
  throw new Error(
    `workers cannot ${action}; read the applied DESIGN.md or ` +
      '.context/docs/design-system.md instead',
  );
}

function evidencePathFor(kit: DesignKit): string {
  return `${EVIDENCE_DIR}/${sanitizeIdentifier(`${kit.sourceId}-${kit.kitId}`)}.json`;
}

function writeCatalogEvidence(
  ctx: AgentGateContext,
  kit: DesignKit,
  assertCurrentAuthority: () => void,
): ContextAttestationSource {
  const relativePath = evidencePathFor(kit);
  assertCurrentAuthority();
  ensureWorkspaceDirectory(ctx.scope, EVIDENCE_DIR);
  const evidence = {
    schemaVersion: 1,
    source: kit.sourceId,
    importedAt: new Date().toISOString(),
    kitId: kit.kitId,
    title: kit.title,
    description: kit.description,
    tags: [...kit.tags],
    license: kit.license,
    locator: kit.locator,
    contentBytes: kit.contentBytes,
    contentHash: kit.contentHash,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  assertCurrentAuthority();
  writeWorkspaceTextFile(ctx.scope, relativePath, json);
  assertCurrentAuthority();
  return {
    type: 'connector',
    locator: relativePath,
    sourceHash: designSha256(json),
  };
}

const MARKERS: Record<DesignKitSourceId, string> = {
  'local-catalog': 'DESIGN.md adapted from the local design reference catalog',
  getdesign: 'DESIGN.md adapted from the open getdesign catalog',
  'designmd.ai': 'DESIGN.md imported from designmd.ai',
};

/**
 * Materialize a chosen kit as the workspace design contract — the same
 * ContextDraft shape the designmd.ai import produces, with provenance naming
 * the source, the kit and the exact content hash that was read.
 */
export function proposeDesignContractFromKit(input: {
  readonly ctx: AgentGateContext;
  readonly kit: DesignKit;
  readonly targetPath: string;
  readonly missionId?: string;
  readonly assertCurrentAuthority: () => void;
}): {
  draftId: string;
  targetPath: string;
  status: string;
  evidencePath: string;
  sourceId: DesignKitSourceId;
  kitId: string;
  contentHash: string;
} {
  const { ctx, kit, targetPath, assertCurrentAuthority } = input;
  const source = writeCatalogEvidence(ctx, kit, assertCurrentAuthority);
  const content = renderDesignContract({
    marker: MARKERS[kit.sourceId],
    sourceId: kit.sourceId,
    kitId: kit.kitId,
    details: [
      `origin: ${kit.locator}`,
      `title: ${kit.title}`,
      `sha256: ${kit.contentHash}`,
    ],
    content: kit.content,
  });

  assertCurrentAuthority();
  const draft = getContextKnowledgeService(ctx.scope).propose(
    {
      ...(input.missionId ? { missionId: input.missionId } : {}),
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
    sourceId: kit.sourceId,
    kitId: kit.kitId,
    contentHash: kit.contentHash,
  };
}

function designSystemLocalListTool(options: DesignSystemToolOptions): McpToolDef {
  return {
    name: 'nexus_design_system_local_list',
    description:
      'List design kits available WITHOUT any API key. ' +
      'source=local-catalog (default) reads the local design reference folder ' +
      '(~/.design-references by default, configurable via orch.designLocalCatalogDir); ' +
      'source=getdesign queries the open getdesign CLI catalog. ' +
      'Use this before nexus_design_system_search when no designmd.ai key is configured.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: [...KEYLESS_SOURCES],
          description: 'Kit source to enumerate (default: local-catalog)',
        },
      },
    },
    handler: async (args, ctx, invocation) => {
      assertMcpInvocationCurrent(invocation);
      assertDesignSystemAuthority(ctx, options);
      assertNotWorker(ctx, 'enumerate design catalogs');
      const sourceId = parseSourceId(str(args, 'source'));

      if (sourceId === 'getdesign') {
        const listed = await listGetDesignKits(options.getDesignSourceOptions ?? {});
        assertMcpInvocationCurrent(invocation);
        return {
          sourceId,
          requiresApiKey: false,
          count: listed.kits.length,
          kits: listed.kits,
          // A static roster must never be mistaken for the live catalog.
          isFallbackList: listed.isFallback,
          listDetail: listed.detail ?? null,
        };
      }

      const catalog = listLocalDesignCatalog({ dir: catalogDir(options) });
      assertMcpInvocationCurrent(invocation);
      return {
        sourceId,
        requiresApiKey: false,
        // Home-relative: the directory is the decision-relevant fact, the OS
        // account name in the absolute path is not, and this value lands in
        // agent context (and from there in transcripts and documents).
        dir: homeRelativePath(catalog.dir),
        dirExists: catalog.exists,
        count: catalog.kits.length,
        kits: catalog.kits,
        skipped: catalog.skipped,
      };
    },
  };
}

function designSystemLocalImportTool(options: DesignSystemToolOptions): McpToolDef {
  return {
    name: 'nexus_design_system_local_import',
    description:
      'Propose a design contract ContextDraft from a keyless kit source ' +
      '(local-catalog or getdesign). Never writes the final DESIGN.md and never ' +
      'copies a third-party brand: the draft states that tokens are ADAPTED to ' +
      'this project. Refuses when the workspace already has a contract unless ' +
      'force is set. Only orchestrator/user sessions may propose drafts.',
    inputSchema: {
      type: 'object',
      properties: {
        kitId: {
          type: 'string',
          description:
            'Kit id from nexus_design_system_local_list (e.g. `linear`, `raycast`)',
        },
        source: {
          type: 'string',
          enum: [...KEYLESS_SOURCES],
          description: 'Kit source (default: local-catalog)',
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
        force: {
          type: 'boolean',
          description:
            'Propose even though the workspace already has a design contract',
        },
      },
      required: ['kitId'],
    },
    handler: async (args, ctx, invocation) => {
      const assertCurrentAuthority = (): void => {
        assertMcpInvocationCurrent(invocation);
        assertDesignSystemAuthority(ctx, options);
      };
      assertCurrentAuthority();
      assertNotWorker(ctx, 'propose context authority drafts');

      const kitId = requireStr(args, 'kitId');
      const sourceId = parseSourceId(str(args, 'source'));
      const targetPath = str(args, 'targetPath') ?? DEFAULT_DESIGN_TARGET_PATH;
      const requestedMissionId = str(args, 'missionId');
      const missionId = requestedMissionId ?? ctx.missionId;
      if (missionId) assertMission(ctx, missionId);

      if (args.force !== true) {
        const existing = findExistingDesignContract(ctx, targetPath);
        if (existing) {
          throw new Error(
            `workspace already has a design contract at ${existing}; ` +
              'prefer it, or pass force to propose a replacement draft',
          );
        }
      }

      const kit = await keylessDesignKitSource(sourceId, options).getKit(kitId);
      assertCurrentAuthority();

      return proposeDesignContractFromKit({
        ctx,
        kit,
        targetPath,
        ...(missionId ? { missionId } : {}),
        assertCurrentAuthority,
      });
    },
  };
}

export function buildKeylessDesignSystemTools(
  options: DesignSystemToolOptions = {},
): McpToolDef[] {
  return [
    designSystemLocalListTool(options),
    designSystemLocalImportTool(options),
  ];
}
