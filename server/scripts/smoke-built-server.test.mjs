import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  compiledServerPath,
  sanitizeSmokeEnvironment,
} from './smoke-built-server.mjs';

describe('compiled server smoke helpers', () => {
  it('keeps build and production start pointed at the same ESM artifact', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts.build).toBe('node scripts/build.mjs');
    expect(packageJson.scripts.start).toContain('dist/index.js');
    expect(packageJson.type).toBe('module');
  });

  it('targets the artifact required by npm start', () => {
    expect(compiledServerPath('/repo/server')).toBe('/repo/server/dist/index.js');
  });

  it('forwards only the minimal cross-platform runtime environment', () => {
    const source = {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      SYSTEMROOT: 'C:\\Windows',
      LANG: 'pt_BR.UTF-8',
      GITHUB_PERSONAL_ACCESS_TOKEN: 'must-not-reach-child',
      APPLE_APP_SPECIFIC_PASSWORD: 'must-not-reach-child',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-child',
      STRIPE_SECRET_KEY: 'must-not-reach-child',
      NODE_OPTIONS: '--require /tmp/injected.cjs',
      ELECTRON_RUN_AS_NODE: '1',
    };

    expect(sanitizeSmokeEnvironment(source)).toEqual({
      PATH: '/safe/bin',
      HOME: '/safe/home',
      SYSTEMROOT: 'C:\\Windows',
      LANG: 'pt_BR.UTF-8',
    });
    expect(source.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('must-not-reach-child');
    expect(source.NODE_OPTIONS).toBe('--require /tmp/injected.cjs');
  });
});
