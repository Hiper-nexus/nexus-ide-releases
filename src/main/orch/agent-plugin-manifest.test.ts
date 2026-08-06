import { describe, expect, it } from 'vitest';
import {
  describePluginIngestion,
  PLUGIN_MANIFEST_SCHEMA,
  readPluginManifest,
  SUPPORTED_PLUGIN_SPEC,
} from './agent-plugin-manifest';

const VALID_MANIFEST = {
  $schema: PLUGIN_MANIFEST_SCHEMA,
  name: 'design-kit',
  version: '2.1.0',
  description: 'Portable design skills',
};

describe('Agent Plugins v1.0.0 manifest validation', () => {
  it('accepts the closed manifest with only its two required fields', () => {
    const verdict = readPluginManifest({
      $schema: PLUGIN_MANIFEST_SCHEMA,
      name: 'design-kit',
    });

    expect(verdict).toMatchObject({
      ok: true,
      name: 'design-kit',
      specVersion: '1.0.0',
      entries: [],
    });
  });

  it('preserves schema-valid metadata without requiring semantic URL formats', () => {
    const verdict = readPluginManifest({
      ...VALID_MANIFEST,
      author: { name: 'Acme', email: 'not necessarily an email', url: 'docs' },
      homepage: 'docs',
      repository: 'git-ish',
      license: 'CUSTOM',
      keywords: ['design', 'review'],
    });

    expect(verdict).toMatchObject({
      ok: true,
      author: { name: 'Acme', email: 'not necessarily an email', url: 'docs' },
      homepage: 'docs',
      repository: 'git-ish',
      license: 'CUSTOM',
      keywords: ['design', 'review'],
    });
  });

  it('rejects a manifest that omits the canonical schema identifier', () => {
    const verdict = readPluginManifest({
      name: 'design-kit',
      skills: ['legacy-inline-component'],
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('$schema');
  });

  it('pins support to exactly v1.0.0 instead of accepting a newer minor', () => {
    const verdict = readPluginManifest({
      $schema: 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json',
      name: 'design-kit',
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain(SUPPORTED_PLUGIN_SPEC);
    expect(verdict.reason).toContain('1.1.0');
  });

  it('rejects ordinary schema violations such as an unknown author field', () => {
    const verdict = readPluginManifest({
      ...VALID_MANIFEST,
      author: { name: 'Acme', handle: '@acme' },
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('author');
  });

  it.each([
    '../../etc/passwd',
    '/absolute',
    'Uppercase',
    '-leading',
    'double--hyphen',
    'double..dot',
  ])('rejects an invalid plugin name: %s', (name) => {
    expect(readPluginManifest({ ...VALID_MANIFEST, name }).ok).toBe(false);
  });

  it.each([
    ['null', null],
    ['string', 'not json'],
    ['array', [1, 2, 3]],
    ['empty object', {}],
    ['numeric name', { ...VALID_MANIFEST, name: 42 }],
  ])('never throws for %s and returns a readable rejection', (_label, raw) => {
    const verdict = readPluginManifest(raw);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it('reports and ignores an unknown top-level field without rejecting v1', () => {
    const verdict = readPluginManifest({
      ...VALID_MANIFEST,
      hooks: ['./hooks.json'],
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.degraded).toEqual([
      expect.objectContaining({ component: 'hooks' }),
    ]);
  });

  it('does not interpret inline skills or agents as v1 components', () => {
    const verdict = readPluginManifest({
      ...VALID_MANIFEST,
      skills: ['inline-is-not-portable'],
      agents: ['v1-has-no-agent-component'],
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.entries).toEqual([]);
    expect(verdict.degraded.map((notice) => notice.component).sort()).toEqual([
      'agents',
      'skills',
    ]);
  });

  it('reports and ignores a non-object extensions field', () => {
    const verdict = readPluginManifest({
      ...VALID_MANIFEST,
      extensions: 'not-an-object',
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.degraded).toEqual([
      expect.objectContaining({ component: 'extensions' }),
    ]);
  });

  it('records unimplemented extension namespaces without validating their values', () => {
    const verdict = readPluginManifest({
      ...VALID_MANIFEST,
      extensions: {
        'com.example.client': 'client-owned invalid-for-core value',
      },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.extensionNamespaces).toEqual(['com.example.client']);
    expect(verdict.degraded[0]?.component).toBe(
      'extensions.com.example.client',
    );
  });
});

describe('manifest ingestion summary', () => {
  it('names the pinned version and every ignored field', () => {
    const text = describePluginIngestion(
      readPluginManifest({ ...VALID_MANIFEST, hooks: ['./hooks.json'] }),
    );

    expect(text).toContain('design-kit 2.1.0');
    expect(text).toContain('Agent Plugins 1.0.0');
    expect(text).toContain('ignorado: hooks');
  });

  it('turns a rejection into user-facing copy', () => {
    expect(describePluginIngestion(readPluginManifest(null))).toContain(
      'Plugin recusado',
    );
  });
});
