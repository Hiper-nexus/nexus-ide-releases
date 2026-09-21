import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIMO_CLI_MODELS } from '../../shared/mimo-models';
import { mimoNativePaths, parseMimoAuth } from '../adapters/mimo-auth';

function explicitApiKey(base: NodeJS.ProcessEnv): string | null {
  const explicit = base.XIAOMI_API_KEY?.trim();
  if (explicit) return explicit;
  try {
    const file = mimoNativePaths(base.HOME ?? os.homedir(), base).authFile;
    if (fs.statSync(file).size > 1_048_576) return null;
    const auth = parseMimoAuth(fs.readFileSync(file, 'utf8'));
    if (!auth || new URL(auth.baseUrl).hostname.startsWith('token-plan-')) return null;
    return auth.key;
  } catch { return null; }
}

/** Automated evaluations must use the separate API product, never Token Plan. */
export function prepareMimoBenchmarkEnv(env: Record<string, string>, base: NodeJS.ProcessEnv) {
  const key = explicitApiKey(base);
  if (!key?.startsWith('sk-')) throw new Error('MiMo automated benchmarks require a separate API key; Token Plan is for interactive coding tools.');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mimo-benchmark-'));
  return {
    env: {
      ...env, HOME: home, USERPROFILE: home, MIMOCODE_HOME: home,
      XIAOMI_API_KEY: key, MIMOCODE_PURE: '1', MIMOCODE_DISABLE_PROJECT_CONFIG: '1',
      MIMOCODE_DISABLE_PROVIDER_ENV: '1', MIMOCODE_DISABLE_CLAUDE_CODE: '1',
      MIMOCODE_DISABLE_AGENTS_SKILLS: '1',
      MIMOCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { xiaomi: { models: MIMO_CLI_MODELS, options: {
          apiKey: '{env:XIAOMI_API_KEY}', baseURL: 'https://api.xiaomimimo.com/v1',
        } } },
      }),
    },
    dispose: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
