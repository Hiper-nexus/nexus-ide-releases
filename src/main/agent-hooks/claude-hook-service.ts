// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: local Claude install only;
// scripts post to Nexus hook listener with NEXUS_* env; paths injectable for tests;
// never authorizes evidence (§12.4).

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

const CLAUDE_EVENTS = [
  { eventName: 'UserPromptSubmit' },
  { eventName: 'Stop' },
  { eventName: 'StopFailure' },
  { eventName: 'PreToolUse', matcher: '*' },
  { eventName: 'PostToolUse', matcher: '*' },
  { eventName: 'PostToolUseFailure', matcher: '*' },
  { eventName: 'PermissionRequest', matcher: '*' },
] as const;

export type ClaudeHookServicePaths = {
  /** User home used to resolve ~/.claude and ~/.nexus/agent-hooks. */
  home?: string;
};

function getConfigPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function getScriptFileName(): string {
  return process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh';
}

function getManagedCommand(scriptPath: string): string {
  // Windows Claude runner expects Git Bash-friendly paths; for Nexus MVP we
  // still wrap via POSIX shell when not win32, and use a minimal .cmd body on win32.
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
      'if "%NEXUS_PANE_KEY%"=="" exit /b 0',
      'set "DROP_DIR=%USERPROFILE%\\.nexus\\agent-hooks\\global"',
      'if not exist "%DROP_DIR%" mkdir "%DROP_DIR%" 2>nul',
      'if "%NEXUS_AGENT_HOOK_PORT%"=="" goto fallback_drop',
      'if "%NEXUS_AGENT_HOOK_TOKEN%"=="" goto fallback_drop',
      '"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%NEXUS_AGENT_HOOK_PORT%/hook/claude" --connect-timeout 0.5 --max-time 1.5 -H "Content-Type: application/x-www-form-urlencoded" -H "X-Nexus-Agent-Hook-Token: %NEXUS_AGENT_HOOK_TOKEN%" --data-urlencode "paneKey=%NEXUS_PANE_KEY%" --data-urlencode "payload@-" >nul 2>&1',
      'if not errorlevel 1 exit /b 0',
      ':fallback_drop',
      'if exist "%DROP_DIR%" (',
      '  powershell -NoProfile -Command "$input | Set-Content -Path \'%DROP_DIR%\\.drop-%NEXUS_PANE_KEY%-%RANDOM%.tmp\' -Encoding UTF8; Move-Item -Force \'%DROP_DIR%\\.drop-%NEXUS_PANE_KEY%-%RANDOM%.tmp\' \'%DROP_DIR%\\%NEXUS_PANE_KEY%--%RANDOM%-claude.json\'" 2>nul',
      ')',
      'exit /b 0',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    'if [ -n "$NEXUS_AGENT_HOOK_ENDPOINT" ] && [ -r "$NEXUS_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$NEXUS_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$NEXUS_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    'drop_dir="${HOME}/.nexus/agent-hooks/global"',
    'mkdir -p "$drop_dir" 2>/dev/null || true',
    'if [ -d "$drop_dir" ]; then',
    '  ts=$(date +%s%3N 2>/dev/null || date +%s000)',
    '  rand=$$-$RANDOM',
    '  tmp="${drop_dir}/.drop-${NEXUS_PANE_KEY}-${rand}.tmp"',
    '  target="${drop_dir}/${NEXUS_PANE_KEY}--${ts}-${rand}-claude.json"',
    '  printf \'%s\' "$payload" > "$tmp" 2>/dev/null && mv -f "$tmp" "$target" 2>/dev/null || rm -f "$tmp" 2>/dev/null',
    'fi',
    'if [ -n "$NEXUS_AGENT_HOOK_PORT" ] && [ -n "$NEXUS_AGENT_HOOK_TOKEN" ]; then',
    '  printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${NEXUS_AGENT_HOOK_PORT}/hook/claude" \\',
    '    --connect-timeout 0.5 --max-time 1.5 \\',
    '    -H "Content-Type: application/x-www-form-urlencoded" \\',
    '    -H "X-Nexus-Agent-Hook-Token: ${NEXUS_AGENT_HOOK_TOKEN}" \\',
    '    --data-urlencode "paneKey=${NEXUS_PANE_KEY}" \\',
    '    --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'fi',
    'exit 0',
    '',
  ].join('\n');
}

function applyManagedHooks(config: HooksConfig, command: string, scriptFileName: string): HooksConfig {
  const nextHooks = { ...config.hooks };
  const isManaged = createManagedCommandMatcher(scriptFileName);
  for (const event of CLAUDE_EVENTS) {
    const current = Array.isArray(nextHooks[event.eventName])
      ? nextHooks[event.eventName]!
      : [];
    const cleaned = removeManagedCommands(current, isManaged);
    const definition: HookDefinition = {
      ...('matcher' in event && event.matcher ? { matcher: event.matcher } : {}),
      hooks: [buildManagedCommandHook(command)],
    };
    nextHooks[event.eventName] = [...cleaned, definition];
  }
  return { ...config, hooks: nextHooks };
}

function stripManagedHooks(
  config: HooksConfig,
  scriptFileName: string,
): { config: HooksConfig; changed: boolean } {
  const nextHooks = { ...config.hooks };
  const isManaged = createManagedCommandMatcher(scriptFileName);
  let changed = false;
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) continue;
    const cleaned = removeManagedCommands(definitions, isManaged);
    if (JSON.stringify(cleaned) !== JSON.stringify(definitions)) changed = true;
    if (cleaned.length === 0) delete nextHooks[eventName];
    else nextHooks[eventName] = cleaned;
  }
  return { config: { ...config, hooks: nextHooks }, changed };
}

export function createClaudeHookService(
  paths: ClaudeHookServicePaths = {},
): ManagedAgentHookService {
  const home = paths.home ?? homedir();
  const scriptFileName = getScriptFileName();

  const getStatus = (): AgentHookInstallStatus => {
    const configPath = getConfigPath(home);
    const scriptPath = getSharedManagedScriptPath(scriptFileName, home);
    const config = readHooksJson(configPath);
    if (!config) {
      return {
        agent: 'claude',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Claude settings.json',
      };
    }
    const command = getManagedCommand(scriptPath);
    const missing: string[] = [];
    let presentCount = 0;
    for (const event of CLAUDE_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : [];
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command),
      );
      if (hasCommand) presentCount += 1;
      else missing.push(event.eventName);
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
      agent: 'claude',
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
        throw new Error('Could not parse Claude settings.json');
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
          agent: 'claude',
          state: 'error',
          configPath,
          managedHooksPresent: false,
          detail: 'Could not parse Claude settings.json',
        };
      }
      const { config: next, changed } = stripManagedHooks(config, scriptFileName);
      if (changed) writeHooksJson(configPath, next);
      return getStatus();
    },
    getStatus,
  };
}
