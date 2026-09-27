import { expect, it } from 'vitest';
import { BUILTIN_ADAPTERS } from './index';
import { adapterSchema } from '../../shared/adapter-types';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { isFileAuthAdapter } from '../../shared/file-auth-adapters';
import { cliInstallRecipeFor, describeInstallRecipe } from '../../main/adapters/cli-install-recipes';
import { primaryKeyEnvVar } from '../../main/adapters/adapter-registry';
import { canUseNexusMcp } from '../../main/orch/cli-mcp-inject';
import { PRESET_HARNESSES } from '../../shared/harness-catalog';
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config';
import { applyInitialPromptToArgv, initialPromptChannel } from '../../shared/cli-initial-prompt';

it('offers the official MiniMax Code CLI with its models, OAuth login and install recipe', () => {
  const raw = BUILTIN_ADAPTERS.find(a => (a as { id: string }).id === 'minimax-code');
  expect(raw).toBeDefined();
  const adapter = adapterSchema.parse(raw);
  if (adapter.kind !== 'cli-pty') throw new Error('MiniMax Code must be a native CLI');
  expect(adapter.bin).toBe('mcode');
  expect(adapter.auth.method).toBe('oauth');
  expect(adapter.models.list).toEqual([
    'minimax/MiniMax-M3',
    'minimax/MiniMax-M3.1-Flash-Preview',
    'minimax/MiniMax-M2.7-highspeed',
    'minimax/MiniMax-M2.7',
  ]);
  expect(adapter.models.default).toBe('minimax/MiniMax-M3');
  // Never resumes "the latest session in cwd": only an exact captured id.
  expect(adapter.spawn.resumeArgs).toEqual([]);
  expect(adapter.spawn.resumeIdArgs).toEqual(['--session']);
  // Worker PTY: the TUI only loads MCP from its data dir or a checkout
  // `.mcp.json`; Nexus MCP reaches MiniMax Code through the ACP harness.
  expect(adapter.quirks.nexusMcp).toBe('none');
  expect(canUseNexusMcp(adapter)).toBe(false);
  // No env key is injected: OAuth lives in ~/.minimax and the TUI ignores it.
  expect(primaryKeyEnvVar(adapter)).toBeNull();
  expect(accountLoginCommandFor('minimax-code')).toBe('mcode login --region global');
  expect(adapter.auth.loginCommand).toBe('mcode login --region global');
  expect(isFileAuthAdapter('minimax-code')).toBe(false);
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const recipe = cliInstallRecipeFor('minimax-code', platform);
    expect(recipe).not.toBeNull();
    expect(describeInstallRecipe(recipe!)).toContain('@minimax-ai/code');
  }
});

it('delivers the first prompt after `--` so a leading dash is never an option', () => {
  const channel = initialPromptChannel({ declared: 'positional', interactive: ['mcode'] });
  expect(channel).toEqual({ kind: 'positional' });
  expect(applyInitialPromptToArgv(['mcode', '--model', 'minimax/MiniMax-M3'], channel, '-p looks like a flag'))
    .toEqual(['mcode', '--model', 'minimax/MiniMax-M3', '--', '-p looks like a flag']);
  expect(applyInitialPromptToArgv(['/opt/bin/mcode.cmd'], channel, 'brief'))
    .toEqual(['/opt/bin/mcode.cmd', '--', 'brief']);
  expect(TUI_AGENT_CONFIG['minimax-code']).toMatchObject({
    detectCmd: 'mcode', promptInjectionMode: 'argv', argvPromptSeparator: '--',
  });
});

it('exposes the native ACP server as a preset harness', () => {
  expect(PRESET_HARNESSES.find((preset) => preset.id === 'minimax-code')).toMatchObject({
    command: 'mcode', args: ['acp'], tier: 'preset', canAutoInstall: false,
  });
});
