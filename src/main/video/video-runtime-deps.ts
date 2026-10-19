import { app } from 'electron';
import { acquireHeavyCommandPermit } from '../orch/heavy-command-permit';
import { isHardenedPolicyActive } from '../orch/gate';
import { getEffectivePath, lookupInPath } from '../path-resolver';
import { bundledEngineManifestDir } from './video-engine';
import type { RenderDeps } from './video-render';

/**
 * Production wiring of the video engine (F-1594/F-1596), shared by the MCP
 * tools and the Estúdio IPC so both run the same pinned engine, PATH, heavy
 * reservation and Hardened refusal.
 */
export function videoRenderDeps(): RenderDeps {
  const pathValue = getEffectivePath();
  return {
    userData: app.getPath('userData'),
    manifestDir: bundledEngineManifestDir(),
    pathValue,
    baseEnv: process.env,
    lookup: (command) => lookupInPath(command, pathValue),
    acquirePermit: acquireHeavyCommandPermit,
    isHardened: isHardenedPolicyActive,
    now: () => new Date(),
  };
}
