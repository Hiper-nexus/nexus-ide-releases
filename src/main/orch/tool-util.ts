import {
  findPane,
  requestPaneSpawn,
  waitForIdle,
} from './pane-registry';
import { orchWriteSession } from '../pty/pty-manager';
import { getAdapter } from '../adapters/adapter-registry';

/** Shared argument helpers + pane-spawn plumbing for the MCP toolset. */

const PROMPT_SETTLE_MS = 150;
const AGENT_BOOT_TIMEOUT_MS = 20_000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function str(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function num(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`missing required argument: ${key}`);
  return value;
}

export function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function sessionIdOf(paneRef: string): string {
  const pane = findPane(paneRef);
  if (!pane) throw new Error(`unknown pane: ${paneRef}`);
  if (!pane.sessionId) throw new Error(`pane ${paneRef} has no live session`);
  return pane.sessionId;
}

/** Type text into a pane's PTY, then press Enter (as a user would). */
export async function injectPrompt(
  sessionId: string,
  prompt: string,
): Promise<void> {
  if (!orchWriteSession(sessionId, prompt)) {
    throw new Error('session is gone');
  }
  await delay(PROMPT_SETTLE_MS);
  orchWriteSession(sessionId, '\r');
}

export interface SpawnToolOptions {
  adapterId: string;
  model?: string;
  cwd?: string;
  title?: string;
  missionId?: string;
  agentName?: string;
  allowedTools?: string[] | null;
  allowedSkills?: string[] | null;
  role?: 'orchestrator' | 'worker';
  prompt?: string;
}

export async function spawnPaneAndMaybePrompt(
  options: SpawnToolOptions,
): Promise<{ paneId: string; sessionId: string }> {
  const adapter = getAdapter(options.adapterId);
  if (!adapter) throw new Error(`unknown adapter: ${options.adapterId}`);
  const result = await requestPaneSpawn(options);
  if (!result.ok || !result.paneId || !result.sessionId) {
    throw new Error(result.error ?? 'pane spawn failed');
  }
  if (options.prompt) {
    // Let the CLI finish booting before typing (first idle or timeout).
    await waitForIdle(result.sessionId, AGENT_BOOT_TIMEOUT_MS);
    await injectPrompt(result.sessionId, options.prompt);
  }
  return { paneId: result.paneId, sessionId: result.sessionId };
}
