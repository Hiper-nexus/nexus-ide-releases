import { createHash } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import { isCurrentGateContext } from './gate';
import type { GetDesignSourceOptions } from '../design/getdesign-cli-source';
import { readWorkspaceTextFile } from './workspace-file';

/**
 * Shared authority surface for every design-system tool (designmd.ai import,
 * Dembrandt extract, local/open catalog import).
 *
 * It lives in its own module so the per-source tool files can reuse the same
 * guards without importing each other.
 */

export const DEFAULT_DESIGN_TARGET_PATH = '.context/docs/design-system.md';
/** Root convention (Google Stitch / awesome-design-md) checked before writing. */
export const ROOT_DESIGN_CONTRACT_PATH = 'DESIGN.md';

export function designSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function missionIdentity(ctx: AgentGateContext) {
  if (!ctx.sessionId) throw new Error('design system action requires a bound agent session');
  return {
    id: ctx.agentName ?? ctx.label,
    sessionId: ctx.sessionId,
    provider: ctx.providerId ?? ctx.label,
  };
}

export function assertMission(ctx: AgentGateContext, requested: string): void {
  if (ctx.missionId && ctx.missionId !== requested) {
    throw new Error('not authorized: mission differs from session mission');
  }
  if (!ctx.missionId && ctx.role !== 'user') {
    throw new Error('not authorized: agent session is not bound to a mission');
  }
}

function readIfPresentInScope(
  scope: ProjectExecutionScope,
  relativePath: string,
): string | null {
  try {
    return readWorkspaceTextFile(scope, relativePath).content;
  } catch (error) {
    if (error instanceof Error && /file not found:/i.test(error.message)) return null;
    throw error;
  }
}

function readIfPresent(
  ctx: AgentGateContext,
  relativePath: string,
): string | null {
  return readIfPresentInScope(ctx.scope, relativePath);
}

export function expectedTargetHash(
  ctx: AgentGateContext,
  targetPath: string,
): string | null {
  const content = readIfPresent(ctx, targetPath);
  return content === null ? null : designSha256(content);
}

/**
 * Which design contract (if any) the workspace already has. Materializing a new
 * contract over an existing one is a decision, not a default: the dembrandt
 * rule is "prefer the existing local contract".
 */
export function findExistingDesignContract(
  ctx: AgentGateContext,
  targetPath: string,
): string | null {
  return findExistingDesignContractInScope(ctx.scope, targetPath);
}

/**
 * Same question without an agent session. The context bootstrap autopilot runs
 * as Main (there is no gate context to pass), and it must answer exactly the
 * same "is a contract already here?" as the agent tools — one rule, one
 * implementation, so the autopilot can never overwrite a contract the tools
 * would have refused to touch.
 */
export function findExistingDesignContractInScope(
  scope: ProjectExecutionScope,
  targetPath: string,
): string | null {
  for (const candidate of [ROOT_DESIGN_CONTRACT_PATH, targetPath]) {
    const content = readIfPresentInScope(scope, candidate);
    if (content !== null && content.trim() !== '') return candidate;
  }
  return null;
}

export function sanitizeIdentifier(raw: string): string {
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

export interface DesignSystemToolOptions {
  /** Renderer IPC supplies a live-scope fence; MCP defaults to bearer identity. */
  readonly assertCurrentAuthority?: (ctx: AgentGateContext) => void;
  /**
   * Internal/test-only runner whose browser layer enforces URL policy on every
   * redirect and subresource request. Production intentionally injects none
   * until a real per-request route guard exists.
   */
  readonly routeGuardedExtractDesignSystem?: (request: {
    readonly normalizedUrl: string;
    readonly paths: readonly string[];
    readonly darkMode: boolean;
    readonly mobile: boolean;
    readonly wcag: boolean;
    readonly workDir: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ designMd: string }>;
  /** Defense-in-depth URL assessment; never substitutes a request route guard. */
  readonly assessExtractUrl?: (
    raw: string,
  ) => Promise<import('../browser/url-policy').BrowserUrlDecision>;
  /** Overrides `orch.designLocalCatalogDir` (tests, embedded runs). */
  readonly localDesignCatalogDir?: string;
  /** Injected CLI runner/workdir for the open catalog (tests never spawn npx). */
  readonly getDesignSourceOptions?: GetDesignSourceOptions;
}

export function assertDesignSystemAuthority(
  ctx: AgentGateContext,
  options: DesignSystemToolOptions,
): void {
  if (options.assertCurrentAuthority) {
    options.assertCurrentAuthority(ctx);
    return;
  }
  if (!isCurrentGateContext(ctx)) {
    throw new Error('design system authority revoked');
  }
}
