import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaGenerationResult } from '../../shared/media-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireGamificationService } from '../gamification/gamification-service';
import type { AgentGateContext } from '../orch/gate';
import { requireProjectUsageStores } from './usage-store-registry';
import { notifyMediaGenerated } from './usage-service';

const MAX_MEDIA_BYTES = 8 * 1024 * 1024 * 1024;

export interface MediaUsageAuthority {
  readonly signal?: AbortSignal;
  readonly assertCurrentAuthority?: () => void;
}

function assertMediaUsageAuthority(authority?: MediaUsageAuthority): void {
  authority?.assertCurrentAuthority?.();
  if (authority?.signal?.aborted) {
    throw new Error('session_authority_revoked');
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function inspectGeneratedFile(
  scope: ProjectExecutionScope,
  candidate: string,
  authority?: MediaUsageAuthority,
): Promise<{ storageKey: string; sha256: string }> {
  assertMediaUsageAuthority(authority);
  const root = await fs.promises.realpath(scope.rootRealPath);
  assertMediaUsageAuthority(authority);
  if (root !== scope.rootRealPath) {
    throw new Error('project root identity changed before media accounting');
  }
  if (!path.isAbsolute(candidate)) {
    throw new Error('generated media path must be absolute');
  }
  const resolved = path.resolve(candidate);
  if (!isInside(root, resolved) || resolved === root) {
    throw new Error('generated media path escapes the project scope');
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const handle = await fs.promises.open(
    resolved,
    fs.constants.O_RDONLY | noFollow,
  );
  assertMediaUsageAuthority(authority);
  try {
    const stat = await handle.stat();
    assertMediaUsageAuthority(authority);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MEDIA_BYTES) {
      throw new Error('generated media is not a safe regular file');
    }
    const pathStat = await fs.promises.lstat(resolved);
    assertMediaUsageAuthority(authority);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== stat.dev ||
      pathStat.ino !== stat.ino
    ) {
      throw new Error('generated media changed after its descriptor opened');
    }
    const real = await fs.promises.realpath(resolved);
    assertMediaUsageAuthority(authority);
    if (!isInside(root, real) || real !== resolved) {
      throw new Error('generated media path changed during accounting');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      assertMediaUsageAuthority(authority);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      assertMediaUsageAuthority(authority);
      if (bytesRead <= 0) {
        throw new Error('generated media ended while hashing');
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return {
      storageKey: path.relative(root, real).split(path.sep).join('/'),
      sha256: digest.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

/**
 * MCP edge: persistence is mandatory. A generated artifact is never reported
 * as successful when its scope-local accounting fails.
 */
export async function recordMediaUsage(
  result: MediaGenerationResult,
  ctx: Pick<AgentGateContext, 'missionId' | 'agentName' | 'label' | 'scope'>,
  authority?: MediaUsageAuthority,
): Promise<string> {
  assertMediaUsageAuthority(authority);
  const inspected = await inspectGeneratedFile(
    ctx.scope,
    result.path,
    authority,
  );
  assertMediaUsageAuthority(authority);
  const stores = requireProjectUsageStores(ctx.scope);
  assertMediaUsageAuthority(authority);
  const id = stores.media.record({
    kind: result.kind,
    provider: result.provider,
    model: result.model,
    storageKey: inspected.storageKey,
    sha256: inspected.sha256,
    costUsd: result.estimatedCostUsd,
    durationMs: result.durationMs,
    missionId: ctx.missionId ?? null,
    agentName: ctx.agentName ?? ctx.label,
  });

  // Persistence already succeeded; derived UI/XP failures are logged and do
  // not rewrite or duplicate the authoritative artifact row.
  try {
    notifyMediaGenerated(ctx.scope);
  } catch (error) {
    console.warn('[media-usage] scoped UI notification failed:', error);
  }
  try {
    requireGamificationService().recordMediaGenerated(
      ctx.scope,
      result.kind,
      ctx.missionId ?? null,
    );
  } catch (error) {
    console.warn('[media-usage] scoped gamification update failed:', error);
  }
  return id;
}
