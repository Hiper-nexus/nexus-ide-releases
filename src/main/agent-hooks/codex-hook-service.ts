// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: lean Codex hooks.json
// installer only (no full TOML trust matrix / WSL remote); paths under user
// home; never authorizes evidence (§12.4).

import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentHookInstallState,
  AgentHookInstallStatus,
} from '../../shared/agent-hook-types';
import type { ManagedAgentHookService } from './managed-agent-hook-controls';
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition,
  type HooksConfig,
} from './installer-utils';

const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
] as const;

export type CodexHookServicePaths = {
  home?: string;
};

function getConfigPath(home: string): string {
  return join(home, '.codex', 'hooks.json');
}

function getScriptFileName(): string {
  return process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh';
}

function getManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    return scriptPath.replaceAll('\\', '/');
  }
  return wrapPosixHookCommand(scriptPath);
}

function buildManagedScriptBody(): string {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined NEXUS_AGENT_HOOK_ENDPOINT if exist "%NEXUS_AGENT_HOOK_ENDPOINT%" call "%NEXUS_AGENT_HOOK_ENDPOINT%" 2>nul',
      'if "%NEXUS_AGENT_HOOK_PORT%"=="" exit /b 0',
      'if "%NEXUS_AGENT_HOOK_TOKEN%"=="" exit /b 0',
      'if "%NEXUS_PANE_KEY%"=="" exit /b 0',
      '"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%NEXUS_AGENT_HOOK_PORT%/hook/codex" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Nexus-Agent-Hook-Token: %NEXUS_AGENT_HOOK_TOKEN%" --data-urlencode "paneKey=%NEXUS_PANE_KEY%" --data-urlencode "payload@-" >nul 2>&1',
      'exit /b 0',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    'if [ -n "$NEXUS_AGENT_HOOK_ENDPOINT" ] && [ -r "$NEXUS_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$NEXUS_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$NEXUS_AGENT_HOOK_PORT" ] || [ -z "$NEXUS_AGENT_HOOK_TOKEN" ] || [ -z "$NEXUS_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${NEXUS_AGENT_HOOK_PORT}/hook/codex" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Nexus-Agent-Hook-Token: ${NEXUS_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${NEXUS_PANE_KEY}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    '',
  ].join('\n');
}

function applyManagedHooks(config: HooksConfig, command: string, scriptFileName: string): HooksConfig {
  const nextHooks: Record<string, HookDefinition[]> = { ...(config.hooks ?? {}) };
  const isManaged = createManagedCommandMatcher(scriptFileName);
  for (const eventName of CODEX_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName]! : [];
    const cleaned = removeManagedCommands(current, isManaged);
    nextHooks[eventName] = [...cleaned, { hooks: [buildManagedCommandHook(command)] }];
  }
  // Codex rejects unknown top-level fields — only `hooks`.
  return { hooks: nextHooks };
}

function stripManagedHooks(
  config: HooksConfig,
  scriptFileName: string,
): { config: HooksConfig; changed: boolean } {
  const nextHooks = { ...(config.hooks ?? {}) };
  const isManaged = createManagedCommandMatcher(scriptFileName);
  let changed = false;
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) continue;
    const cleaned = removeManagedCommands(definitions, isManaged);
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) changed = true;
    if (cleaned.length === 0) delete nextHooks[eventName];
    else nextHooks[eventName] = cleaned;
  }
  return { config: { hooks: nextHooks }, changed };
}

export function createCodexHookService(
  paths: CodexHookServicePaths = {},
): ManagedAgentHookService {
  const home = paths.home ?? homedir();
  const scriptFileName = getScriptFileName();

  const getStatus = (): AgentHookInstallStatus => {
    const configPath = getConfigPath(home);
    const scriptPath = getSharedManagedScriptPath(scriptFileName, home);
    const config = readHooksJson(configPath);
    if (!config) {
      return {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Codex hooks.json',
      };
    }
    const command = getManagedCommand(scriptPath);
    const missing: string[] = [];
    let presentCount = 0;
    for (const eventName of CODEX_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[eventName])
        ? config.hooks![eventName]!
        : [];
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command),
      );
      if (hasCommand) presentCount += 1;
      else missing.push(eventName);
    }
    let state: AgentHookInstallState;
    let detail: string | null;
    if (missing.length === 0) {
      state = 'installed';
      detail = null;
    } else if (presentCount === 0) {
      state = 'not_installed';
      detail = null;
    } else {
      state = 'partial';
      detail = `Managed hook missing for events: ${missing.join(', ')}`;
    }
    return {
      agent: 'codex',
      state,
      configPath,
      managedHooksPresent: presentCount > 0,
      detail,
    };
  };

  return {
    install(): void {
      const configPath = getConfigPath(home);
      const scriptPath = getSharedManagedScriptPath(scriptFileName, home);
      const config = readHooksJson(configPath);
      if (!config) {
        throw new Error('Could not parse Codex hooks.json');
      }
      const command = getManagedCommand(scriptPath);
      const next = applyManagedHooks(config, command, scriptFileName);
      writeManagedScript(scriptPath, buildManagedScriptBody());
      writeHooksJson(configPath, next);
    },
    remove(): AgentHookInstallStatus {
      const configPath = getConfigPath(home);
      const config = readHooksJson(configPath);
      if (!config) {
        return {
          agent: 'codex',
          state: 'error',
          configPath,
          managedHooksPresent: false,
          detail: 'Could not parse Codex hooks.json',
        };
      }
      const { config: next, changed } = stripManagedHooks(config, scriptFileName);
      if (changed) writeHooksJson(configPath, next);
      return getStatus();
    },
    getStatus,
  };
}
