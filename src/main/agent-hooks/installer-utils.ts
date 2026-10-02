// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: lean subset for Claude+Codex
// local installers only; shared path under ~/.nexus/agent-hooks; no win32 ACL helpers.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type HookCommandConfig = {
  type: 'command';
  command: string;
  timeout?: number;
  [key: string]: unknown;
};

export type HookDefinition = {
  matcher?: string;
  command?: string;
  hooks?: HookCommandConfig[];
  [key: string]: unknown;
};

export type HooksConfig = {
  hooks?: Record<string, HookDefinition[]>;
  [key: string]: unknown;
};

export const MANAGED_HOOK_TIMEOUT_SECONDS = 10;

/**
 * Load port/token from the hook endpoint file. On Windows `call file.env`
 * is ShellExecute: every Claude/Codex hook opened the "choose an app for
 * .env" dialog. A `.cmd` may still be called; a `.env` is only parsed.
 *
 * F-745: outside a Nexus pane the variable is undefined, `%VAR:~-4%` does not
 * expand and the multi-line `if … (` block fails to parse — "A sintaxe do
 * comando está incorreta", exit 255, on every hook of a CLI the operator runs
 * on their own. `goto` skips the block without parsing it.
 */
export function windowsHookEndpointLoadLines(): readonly string[] {
  return [
    'if not defined NEXUS_AGENT_HOOK_ENDPOINT goto nexus_hook_post',
    'if /i "%NEXUS_AGENT_HOOK_ENDPOINT:~-4%"==".cmd" if exist "%NEXUS_AGENT_HOOK_ENDPOINT%" call "%NEXUS_AGENT_HOOK_ENDPOINT%"',
    'if /i not "%NEXUS_AGENT_HOOK_ENDPOINT:~-4%"==".cmd" if exist "%NEXUS_AGENT_HOOK_ENDPOINT%" (',
    '  for /f "usebackq tokens=2 delims=\'" %%P in (`findstr /b /c:"export NEXUS_AGENT_HOOK_PORT=" "%NEXUS_AGENT_HOOK_ENDPOINT%"`) do set "NEXUS_AGENT_HOOK_PORT=%%P"',
    '  for /f "usebackq tokens=2 delims=\'" %%T in (`findstr /b /c:"export NEXUS_AGENT_HOOK_TOKEN=" "%NEXUS_AGENT_HOOK_ENDPOINT%"`) do set "NEXUS_AGENT_HOOK_TOKEN=%%T"',
    ')',
    ':nexus_hook_post',
  ];
}

export function buildManagedCommandHook(
  command: string,
  timeout = MANAGED_HOOK_TIMEOUT_SECONDS,
): HookCommandConfig {
  return { type: 'command', command, timeout };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readHooksJson(configPath: string): HooksConfig | null {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createManagedCommandMatcher(
  scriptFileName: string,
): (command: string | undefined) => boolean {
  const scriptStem = scriptFileName.replace(/\.(?:cmd|sh)$/, '');
  const needles = [
    `agent-hooks/${scriptFileName}`,
    `agent-hooks/${scriptStem}.cmd`,
    `agent-hooks/${scriptStem}.sh`,
  ];
  return (command) => {
    if (!command) return false;
    const normalized = command.replaceAll('\\', '/');
    return needles.some((needle) => normalized.includes(needle));
  };
}

/** Shared managed scripts live under user home, never project `.nexus/`. */
export function getSharedManagedScriptPath(
  scriptFileName: string,
  home: string = homedir(),
): string {
  return join(home, '.nexus', 'agent-hooks', scriptFileName);
}

export function wrapPosixHookCommand(scriptPath: string): string {
  const quoted = `'${scriptPath.replaceAll("'", "'\\''")}'`;
  return `if [ -x ${quoted} ]; then /bin/sh ${quoted}; fi`;
}

export function removeManagedCommands(
  definitions: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean,
): HookDefinition[] {
  return definitions.flatMap((definition) => {
    const hasNested = Array.isArray(definition.hooks);
    const hasManagedNested =
      hasNested && definition.hooks!.some((hook) => isManagedCommand(hook.command));
    const directManaged = isManagedCommand(definition.command);

    if (!directManaged && !hasManagedNested) {
      return [definition];
    }

    const next: HookDefinition = { ...definition };
    if (directManaged) {
      delete next.command;
    }
    if (hasManagedNested) {
      const filtered = definition.hooks!.filter((hook) => !isManagedCommand(hook.command));
      if (filtered.length > 0) next.hooks = filtered;
      else delete next.hooks;
    }
    const stillHas =
      typeof next.command === 'string' ||
      (Array.isArray(next.hooks) && next.hooks.length > 0);
    return stillHas ? [next] : [];
  });
}

export function writeManagedScript(scriptPath: string, content: string): void {
  const dir = dirname(scriptPath);
  mkdirSync(dir, { recursive: true });
  if (existsSync(scriptPath)) {
    try {
      if (readFileSync(scriptPath, 'utf-8') === content) {
        if (process.platform !== 'win32') chmodSync(scriptPath, 0o755);
        return;
      }
    } catch {
      // fall through
    }
  }
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    if (process.platform !== 'win32') chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, scriptPath);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort
      }
    }
  }
}

function replacePrivateTextFile(
  filePath: string,
  content: string,
  mode: number,
): void {
  const tmpPath = join(
    dirname(filePath),
    `.${Date.now()}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, filePath);
    chmodSync(filePath, mode);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort
      }
    }
  }
}

function restrictedOwnerMode(filePath: string, fallback = 0o600): number {
  try {
    const mode = statSync(filePath).mode & 0o600;
    return mode === 0 ? fallback : mode;
  } catch {
    return fallback;
  }
}

export function writeHooksJson(configPath: string, config: HooksConfig): void {
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  const backupPath = `${configPath}.bak`;
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  let privateMode = 0o600;
  if (existsSync(configPath)) {
    privateMode = restrictedOwnerMode(configPath);
    try {
      if (readFileSync(configPath, 'utf-8') === serialized) {
        chmodSync(configPath, privateMode);
        if (existsSync(backupPath)) {
          chmodSync(
            backupPath,
            restrictedOwnerMode(backupPath, privateMode),
          );
        }
        return;
      }
    } catch {
      // fall through
    }
  }
  if (existsSync(configPath)) {
    replacePrivateTextFile(
      backupPath,
      readFileSync(configPath, 'utf-8'),
      privateMode,
    );
  }
  replacePrivateTextFile(configPath, serialized, privateMode);
}
