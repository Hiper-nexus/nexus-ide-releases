import { expect, it } from 'vitest';
import { BUILTIN_ADAPTERS } from './index';
import { adapterSchema } from '../../shared/adapter-types';
import { accountLoginCommandFor } from '../../shared/account-login-commands';
import { isFileAuthAdapter } from '../../shared/file-auth-adapters';
import { cliInstallRecipeFor, describeInstallRecipe } from '../../main/adapters/cli-install-recipes';
import { primaryKeyEnvVar } from '../../main/adapters/adapter-registry';

it('offers the official MiMo CLI with Xiaomi V2.6 models and account login', () => {
  const raw = BUILTIN_ADAPTERS.find(a => (a as { id: string }).id === 'mimo-code');
  expect(raw).toBeDefined();
  const adapter = adapterSchema.parse(raw);
  if (adapter.kind !== 'cli-pty') throw new Error('MiMo must be a native CLI');
  expect(adapter.bin).toBe('mimo');
  expect(adapter.models.list).toEqual(expect.arrayContaining(['xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro']));
  expect(adapter.models.default).toBe('xiaomi/mimo-v2.6-flash');
  expect(adapter.spawn.initialPrompt).toBe('interactive-flag');
  expect(adapter.spawn.initialPromptFlag).toBe('--prompt');
  expect(adapter.spawn.resumeIdArgs).toEqual(['--session']);
  expect(adapter.quirks.mcpAutoload).toBe(false);
  expect(adapter.quirks.nexusMcp).toBe('mimo-code');
  expect(primaryKeyEnvVar(adapter)).toBe('XIAOMI_API_KEY');
  expect(accountLoginCommandFor('mimo-code')).toBe('mimo providers login --provider xiaomi');
  expect(isFileAuthAdapter('mimo-code')).toBe(true);
  for (const platform of ['darwin','linux','win32'] as const) {
    const recipe = cliInstallRecipeFor('mimo-code', platform);
    expect(recipe).not.toBeNull();
    expect(describeInstallRecipe(recipe!)).toContain('@mimo-ai/cli');
  }
});
