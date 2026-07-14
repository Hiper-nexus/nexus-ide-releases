/**
 * Env + bootstrap inject for OSC 133 shell integration when CommandBlocks
 * flag is ON. Does not rewrite user rc files permanently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

export function isShellIntegrationEnabled(): boolean {
  return getFeatureFlagRegistry().isEnabled(
    FEATURE_FLAG_IDS.terminalCommandBlocks,
  );
}

/** Resolve packaged/dev path to resources/shell-integration/. */
export function resolveShellIntegrationDir(): string | null {
  const candidates: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'shell-integration'));
  }
  // Electron may expose app path via env in packaged builds.
  if (process.env.NEXUS_RESOURCES_DIR) {
    candidates.push(
      path.join(process.env.NEXUS_RESOURCES_DIR, 'shell-integration'),
    );
  }
  candidates.push(path.join(process.cwd(), 'resources', 'shell-integration'));
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'nexus-osc133.zsh'))) {
      return dir;
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Merge NEXUS_SHELL_INTEGRATION marker into child env when flag is on.
 */
export function applyShellIntegrationEnv(
  env: Record<string, string>,
  shellPath: string,
): Record<string, string> {
  if (!isShellIntegrationEnabled()) return env;
  const dir = resolveShellIntegrationDir();
  if (!dir) {
    return { ...env, NEXUS_SHELL_INTEGRATION: '1' };
  }

  const next: Record<string, string> = {
    ...env,
    NEXUS_SHELL_INTEGRATION: '1',
  };
  const base = path.basename(shellPath).toLowerCase();
  if (base.includes('zsh')) {
    next.NEXUS_OSC133_ZSH = path.join(dir, 'nexus-osc133.zsh');
  } else if (base.includes('bash')) {
    next.NEXUS_OSC133_BASH = path.join(dir, 'nexus-osc133.bash');
  } else if (base.includes('fish')) {
    next.NEXUS_OSC133_FISH = path.join(dir, 'nexus-osc133.fish');
  }
  return next;
}

/**
 * One-shot source line to write into a fresh interactive PTY.
 * Null when flag off / unknown shell / scripts missing.
 */
export function shellIntegrationBootstrapCommand(
  shellPath: string,
): string | null {
  if (!isShellIntegrationEnabled()) return null;
  const dir = resolveShellIntegrationDir();
  if (!dir) return null;
  const base = path.basename(shellPath).toLowerCase();
  if (base.includes('zsh')) {
    const script = path.join(dir, 'nexus-osc133.zsh');
    const q = shellQuote(script);
    return `[[ -f ${q} ]] && source ${q}\n`;
  }
  if (base.includes('bash')) {
    const script = path.join(dir, 'nexus-osc133.bash');
    const q = shellQuote(script);
    return `[[ -f ${q} ]] && source ${q}\n`;
  }
  if (base.includes('fish')) {
    const script = path.join(dir, 'nexus-osc133.fish');
    const q = shellQuote(script);
    return `test -f ${q}; and source ${q}\n`;
  }
  return null;
}
