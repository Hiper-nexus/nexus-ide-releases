import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DembrandtExtractError,
  DEMBRANDT_PACKAGE,
  extractDesignSystemFromUrl,
  __test,
} from './dembrandt-extractor';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('dembrandt-extractor', () => {
  it('builds pinned CLI args with optional flags and paths', () => {
    expect(
      __test.buildCliArgs({
        normalizedUrl: 'https://stripe.com/',
        paths: ['pricing', '/docs'],
        darkMode: true,
        mobile: true,
        wcag: false,
        workDir: '/tmp',
      }),
    ).toEqual([
      '-y',
      DEMBRANDT_PACKAGE,
      'https://stripe.com/',
      '--design-md',
      '/pricing',
      '/docs',
      '--dark-mode',
      '--mobile',
    ]);
    expect(__test.buildCliArgs({
      normalizedUrl: 'https://stripe.com/',
      paths: [],
      darkMode: false,
      mobile: false,
      wcag: false,
      workDir: '/tmp',
    })).not.toContain('--no-sandbox');
  });

  it('builds a child env allowlist that drops secrets', () => {
    const env = __test.buildDembrandtChildEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'sk-secret',
      NEXUS_VAULT_KEY: 'vault',
      DEMBRANDT_API_KEY: 'dmb',
      GITHUB_TOKEN: 'gh',
      npm_config_yes: 'false',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.npm_config_yes).toBe('true');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NEXUS_VAULT_KEY).toBeUndefined();
    expect(env.DEMBRANDT_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('finds DESIGN.md under nested output/', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dembrandt-find-'));
    tempDirs.push(workDir);
    const nested = path.join(workDir, 'output', 'stripe.com', 'run');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'DESIGN.md'), '# Tokens\n');
    expect(__test.findDesignMd(workDir)).toBe(path.join(nested, 'DESIGN.md'));
  });

  it('blocks private-network URLs before spawning the CLI', async () => {
    await expect(
      extractDesignSystemFromUrl({
        url: 'http://127.0.0.1:3000',
        assessUrl: async () => ({
          allowed: false,
          kind: 'private-network',
          reason: 'private-network access requires explicit confirmation',
          normalizedUrl: 'http://127.0.0.1:3000/',
        }),
        runner: async () => {
          throw new Error('runner must not run');
        },
      }),
    ).rejects.toMatchObject({
      name: 'DembrandtExtractError',
      code: 'URL_BLOCKED',
    });
  });

  it('returns DESIGN.md from the injectable runner after a public URL passes policy', async () => {
    const result = await extractDesignSystemFromUrl({
      url: 'stripe.com',
      assessUrl: async () => ({
        allowed: true,
        normalizedUrl: 'https://stripe.com/',
        targetKey: 'https://stripe.com/',
        addresses: ['1.2.3.4'],
        addressClasses: ['public'],
      }),
      runner: async (request) => {
        expect(request.normalizedUrl).toBe('https://stripe.com/');
        expect(request.workDir).toMatch(/nexus-dembrandt-/);
        return { designMd: '---\nname: Stripe\n---\n\n## Colors\n' };
      },
    });

    expect(result.normalizedUrl).toBe('https://stripe.com/');
    expect(result.sourceUrl).toBe('stripe.com');
    expect(result.designMd).toContain('## Colors');
  });

  it('surfaces runner failures as DembrandtExtractError when thrown as such', async () => {
    await expect(
      extractDesignSystemFromUrl({
        url: 'https://example.com',
        assessUrl: async () => ({
          allowed: true,
          normalizedUrl: 'https://example.com/',
          targetKey: 'https://example.com/',
          addresses: ['1.2.3.4'],
          addressClasses: ['public'],
        }),
        runner: async () => {
          throw new DembrandtExtractError('EXTRACTION_FAILED', 'boom');
        },
      }),
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' });
  });
});
