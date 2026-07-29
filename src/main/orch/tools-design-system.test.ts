import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
} from '../context/context-workflow-registry';
import { ensureContextScaffold } from '../context/context-doctor';
import { getContextKnowledgeService } from '../context/context-workflow-registry';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { AgentGateContext } from './gate';
import {
  buildDesignSystemTools,
  type DesignSystemToolOptions,
} from './tools-design-system';

const stubs = vi.hoisted(() => ({
  searchKits: vi.fn(),
  getKit: vi.fn(),
  publishKit: vi.fn(),
  listPopularKits: vi.fn(),
  listTags: vi.fn(),
}));

vi.mock('../design/designmd-api-client', () => ({
  DesignMdApiClient: vi.fn().mockImplementation(() => ({
    searchKits: stubs.searchKits,
    getKit: stubs.getKit,
    publishKit: stubs.publishKit,
    listPopularKits: stubs.listPopularKits,
    listTags: stubs.listTags,
  })),
  DesignMdApiError: class DesignMdApiError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DesignMdApiError';
    }
  },
  DesignMdAuthError: class DesignMdAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'DesignMdAuthError';
    }
  },
  DesignMdLicenseError: class DesignMdLicenseError extends Error {
    readonly license: string;
    constructor(license: string, message: string) {
      super(message);
      this.name = 'DesignMdLicenseError';
      this.license = license;
    }
  },
  DESIGNMD_BASE_URL: 'https://designmd.ai/api/v1',
  DESIGNMD_API_KEY_SECRET: 'external:designmd-api-key',
}));

let baseDir = '';
let root = '';
let manager: ProjectRuntimeManager;
let scope: ProjectExecutionScope;

function context(
  providerId: string,
  sessionId: string,
  role: AgentGateContext['role'] = 'orchestrator',
  missionId?: string,
): AgentGateContext {
  return {
    token: `token-${sessionId}`,
    label: providerId,
    role,
    sessionId,
    agentName: `${providerId}-agent`,
    providerId,
    missionId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(
  name: string,
  options: DesignSystemToolOptions = { assertCurrentAuthority: () => {} },
) {
  const found = buildDesignSystemTools(options).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function kitSummary() {
  return {
    slug: 'acme/clean',
    name: 'Clean UI Kit',
    description: 'A clean starter kit.',
    author: 'Acme',
    url: 'https://designmd.ai/acme/clean',
    tags: ['minimal', 'saas'],
    license: 'mit' as const,
    downloadCount: 42,
    likeCount: 7,
  };
}

function kitDetail() {
  return {
    ...kitSummary(),
    content: '# DESIGN.md\n\nUse a 4pt grid.',
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-system-runtime-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-system-')));
  scope = Object.freeze({
    version: 1,
    installationId: 'installation-tools',
    projectId: 'project-tools',
    checkoutId: 'checkout-tools',
    rootRealPath: root,
    identitySource: 'manifest',
  });
  manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  configureContextWorkflowRegistry(manager, { appVersion: 'test' });
  ensureContextScaffold(scope);
  stubs.searchKits.mockReset();
  stubs.getKit.mockReset();
  stubs.publishKit.mockReset();
  stubs.listPopularKits.mockReset();
  stubs.listTags.mockReset();
});

afterEach(() => {
  disposeContextWorkflowRegistry();
  manager.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('nexus_design_system_search', () => {
  it('returns public search results without an API key', async () => {
    stubs.searchKits.mockResolvedValue([kitSummary()]);

    const result = (await tool('nexus_design_system_search').handler({
      query: 'clean',
      tags: ['minimal'],
      sort: 'popular',
      limit: 10,
    }, context('codex', 'session-1'))) as { count: number; kits: unknown[] };

    expect(result.count).toBe(1);
    expect(result.kits[0]).toMatchObject({ slug: 'acme/clean' });
    expect(stubs.searchKits).toHaveBeenCalledWith({
      query: 'clean',
      tags: ['minimal'],
      sort: 'popular',
      limit: 10,
    });
  });
});

describe('nexus_design_system_get', () => {
  it('returns kit metadata and content using the stored API key', async () => {
    stubs.getKit.mockResolvedValue(kitDetail());

    const result = (await tool('nexus_design_system_get').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))) as { content: string; license: string };

    expect(result.content).toBe('# DESIGN.md\n\nUse a 4pt grid.');
    expect(result.license).toBe('mit');
    expect(stubs.getKit).toHaveBeenCalledWith('acme/clean');
  });

  it('propagates authentication errors from the API client', async () => {
    stubs.getKit.mockRejectedValue(new Error('missing key'));

    await expect(tool('nexus_design_system_get').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))).rejects.toThrow(/missing key/);
  });
});

describe('nexus_design_system_import', () => {
  it('creates a proposed ContextDraft with connector evidence', async () => {
    stubs.getKit.mockResolvedValue(kitDetail());

    const result = (await tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))) as {
      draftId: string;
      targetPath: string;
      status: string;
      evidencePath: string;
    };

    expect(result.status).toBe('proposed');
    expect(result.targetPath).toBe('.context/docs/design-system.md');
    expect(result.evidencePath).toMatch(/^\.context\/nexus\/evidence\/designmd-ai\//);

    const evidenceAbsolute = path.join(root, result.evidencePath);
    expect(fs.existsSync(evidenceAbsolute)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(evidenceAbsolute, 'utf8')) as Record<string, unknown>;
    expect(evidence.source).toBe('designmd.ai');
    expect(evidence.slug).toBe('acme/clean');

    // The DESIGN.md target must NOT be written yet — only the draft exists.
    expect(fs.existsSync(path.join(root, result.targetPath))).toBe(false);

    const read = getContextKnowledgeService(scope).get(result.draftId);
    expect(read).not.toBeNull();
    expect(read!.content).toContain('Use a 4pt grid.');
    expect(read!.content).toContain('imported from designmd.ai');
    expect(read!.sources).toHaveLength(1);
    expect(read!.sources[0].type).toBe('connector');
    expect(read!.sources[0].locator).toBe(result.evidencePath);
    expect(read!.sources[0].sourceHash).toBe(
      createHash('sha256').update(fs.readFileSync(evidenceAbsolute, 'utf8')).digest('hex'),
    );
  });

  it('respects a custom targetPath and hashes an existing file', async () => {
    stubs.getKit.mockResolvedValue(kitDetail());
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    const existing = '# Existing\n';
    fs.writeFileSync(path.join(root, '.context', 'docs', 'design-system.md'), existing);

    const result = (await tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
      targetPath: '.context/docs/design-system.md',
    }, context('codex', 'session-1'))) as { status: string };

    expect(result.status).toBe('proposed');
  });

  it('writes no evidence or draft when workspace authority changes during getKit', async () => {
    let resolveKit!: (kit: ReturnType<typeof kitDetail>) => void;
    stubs.getKit.mockReturnValue(
      new Promise((resolve) => {
        resolveKit = resolve;
      }),
    );
    let live = true;
    const importTool = tool('nexus_design_system_import', {
      assertCurrentAuthority: () => {
        if (!live) throw new Error('renderer workspace authority changed');
      },
    });

    const pending = importTool.handler(
      { identifier: 'acme/clean' },
      context('codex', 'session-revoked'),
    );
    expect(stubs.getKit).toHaveBeenCalledTimes(1);
    live = false;
    resolveKit(kitDetail());

    await expect(pending).rejects.toThrow(/workspace authority changed/i);
    expect(
      fs.existsSync(path.join(root, '.context', 'nexus', 'evidence', 'designmd-ai')),
    ).toBe(false);
    expect(getContextKnowledgeService(scope).list({ status: 'proposed' })).toEqual([]);
  });

  it('rejects import by workers', async () => {
    await expect(tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
    }, context('codex', 'worker-session', 'worker'))).rejects.toThrow(/workers cannot propose/);
  });

  it('blocks cc-by-sa kits by default', async () => {
    stubs.getKit.mockResolvedValue({ ...kitDetail(), license: 'cc-by-sa' as const });

    await expect(tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))).rejects.toThrow(/cc-by-sa/);
  });

  it('blocks proprietary kits by default', async () => {
    stubs.getKit.mockResolvedValue({ ...kitDetail(), license: 'proprietary' as const });

    await expect(tool('nexus_design_system_import').handler({
      identifier: 'acme/clean',
    }, context('codex', 'session-1'))).rejects.toThrow(/proprietary/);
  });
});

describe('nexus_design_system_extract', () => {
  it('fails closed by default while Dembrandt lacks a per-request route guard', async () => {
    const extractTool = tool('nexus_design_system_extract', {
      assertCurrentAuthority: () => {},
    });

    await expect(
      extractTool.handler(
        { url: 'https://linear.app' },
        context('codex', 'session-no-network-guard'),
      ),
    ).rejects.toThrow(
      /NETWORK_GUARD_UNAVAILABLE.*per-request.*redirect.*subresource/i,
    );
    expect(
      fs.existsSync(path.join(root, '.context', 'nexus', 'evidence', 'dembrandt')),
    ).toBe(false);
    expect(getContextKnowledgeService(scope).list({ status: 'proposed' })).toEqual([]);
  });

  it('proposes a ContextDraft from a live URL without writing the final file', async () => {
    const extractTool = tool('nexus_design_system_extract', {
      assertCurrentAuthority: () => {},
      assessExtractUrl: async () => ({
        allowed: true,
        normalizedUrl: 'https://linear.app/',
        targetKey: 'https://linear.app/',
        addresses: ['1.2.3.4'],
        addressClasses: ['public'],
      }),
      routeGuardedExtractDesignSystem: async () => ({
        designMd: '---\nname: Linear\n---\n\n## Overview\nMinimal.\n',
      }),
    });

    const result = (await extractTool.handler(
      { url: 'https://linear.app' },
      context('codex', 'session-extract'),
    )) as {
      draftId: string;
      targetPath: string;
      status: string;
      evidencePath: string;
      normalizedUrl: string;
    };

    expect(result.status).toBe('proposed');
    expect(result.targetPath).toBe('.context/docs/design-system.md');
    expect(result.normalizedUrl).toBe('https://linear.app/');
    expect(result.evidencePath).toContain('.context/nexus/evidence/dembrandt/');
    expect(fs.existsSync(path.join(root, result.evidencePath))).toBe(true);
    expect(fs.existsSync(path.join(root, 'DESIGN.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.context', 'docs', 'design-system.md'))).toBe(false);

    const evidence = JSON.parse(
      fs.readFileSync(path.join(root, result.evidencePath), 'utf8'),
    ) as Record<string, unknown>;
    expect(evidence.source).toBe('dembrandt');
    expect(evidence.content).toBeUndefined();
    expect(typeof evidence.contentHash).toBe('string');
    expect(evidence.contentBytes).toBeGreaterThan(0);

    const drafts = getContextKnowledgeService(scope).list({ status: 'proposed' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.content).toContain('extracted by Dembrandt');
    expect(drafts[0]?.content).toContain('UNTRUSTED until independently reviewed');
    expect(drafts[0]?.content).toContain('## Overview');
  });

  it('writes no evidence or draft when workspace authority changes during extract', async () => {
    let live = true;
    let resolveExtract: ((value: { designMd: string }) => void) | undefined;
    const extractTool = tool('nexus_design_system_extract', {
      assertCurrentAuthority: () => {
        if (!live) throw new Error('renderer workspace authority changed');
      },
      assessExtractUrl: async () => ({
        allowed: true,
        normalizedUrl: 'https://linear.app/',
        targetKey: 'https://linear.app/',
        addresses: ['1.2.3.4'],
        addressClasses: ['public'],
      }),
      routeGuardedExtractDesignSystem: () =>
        new Promise<{ designMd: string }>((resolve) => {
          resolveExtract = resolve;
        }),
    });

    const pending = extractTool.handler(
      { url: 'https://linear.app' },
      context('codex', 'session-revoked-extract'),
    );
    await vi.waitFor(() => {
      expect(resolveExtract).toBeTypeOf('function');
    });
    live = false;
    resolveExtract!({ designMd: '---\nname: Linear\n---\n' });

    await expect(pending).rejects.toThrow(/workspace authority changed/i);
    expect(
      fs.existsSync(path.join(root, '.context', 'nexus', 'evidence', 'dembrandt')),
    ).toBe(false);
    expect(getContextKnowledgeService(scope).list({ status: 'proposed' })).toEqual([]);
  });

  it('rejects extract by workers', async () => {
    await expect(
      tool('nexus_design_system_extract').handler(
        { url: 'https://linear.app' },
        context('codex', 'worker-session', 'worker'),
      ),
    ).rejects.toThrow(/workers cannot propose/);
  });

  it('surfaces private-network blocks from URL policy', async () => {
    const extractTool = tool('nexus_design_system_extract', {
      assertCurrentAuthority: () => {},
      assessExtractUrl: async () => ({
        allowed: false,
        kind: 'private-network',
        reason: 'private-network access requires explicit confirmation',
      }),
      routeGuardedExtractDesignSystem: async () => {
        throw new Error('runner must not run');
      },
    });

    await expect(
      extractTool.handler(
        { url: 'http://192.168.0.10' },
        context('codex', 'session-private'),
      ),
    ).rejects.toThrow(/URL_BLOCKED|private-network/i);
  });
});

describe('nexus_design_system_publish', () => {
  it('publishes the canonical DESIGN.md with overrides', async () => {
    stubs.publishKit.mockResolvedValue({ ...kitDetail(), url: 'https://designmd.ai/published/clean' });
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.context', 'docs', 'design-system.md'), '# DESIGN.md\n\nUse a 4pt grid.');

    const result = (await tool('nexus_design_system_publish').handler({
      slug: 'myteam/published',
      name: 'Published Kit',
      tags: ['published'],
      license: 'cc0',
    }, context('codex', 'session-1'))) as { slug: string; url: string; license: string };

    expect(result.slug).toBe('acme/clean');
    expect(result.url).toBe('https://designmd.ai/published/clean');
    expect(result.license).toBe('mit');
    expect(stubs.publishKit).toHaveBeenCalledWith({
      slug: 'myteam/published',
      name: 'Published Kit',
      description: '',
      tags: ['published'],
      license: 'cc0',
      content: '# DESIGN.md\n\nUse a 4pt grid.',
    });
  });

  it('rejects publish by workers', async () => {
    await expect(tool('nexus_design_system_publish').handler({
      slug: 'myteam/published',
      name: 'Published Kit',
    }, context('codex', 'worker-session', 'worker'))).rejects.toThrow(/workers cannot publish/);
  });

  it('propagates cancellation and rejects a publish response after authority revocation', async () => {
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.context', 'docs', 'design-system.md'),
      '# DESIGN.md\n',
    );
    let resolvePublish!: (value: ReturnType<typeof kitDetail>) => void;
    stubs.publishKit.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePublish = resolve;
      }),
    );
    const controller = new AbortController();
    let current = true;
    const pending = tool('nexus_design_system_publish').handler(
      { slug: 'team/revoked', name: 'Revoked' },
      context('codex', 'revoked-publisher'),
      {
        signal: controller.signal,
        assertCurrentAuthority: () => {
          if (!current) throw new Error('session_authority_revoked');
        },
      },
    );
    await vi.waitFor(() => expect(stubs.publishKit).toHaveBeenCalledOnce());
    expect(stubs.publishKit).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'team/revoked' }),
      { signal: controller.signal },
    );
    current = false;
    controller.abort();
    resolvePublish(kitDetail());

    await expect(pending).rejects.toThrow('session_authority_revoked');
  });

  it('reads frontmatter defaults from the DESIGN.md', async () => {
    stubs.publishKit.mockResolvedValue(kitDetail());
    fs.mkdirSync(path.join(root, '.context', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.context', 'docs', 'design-system.md'),
      '---\nname: Frontmatter Kit\nslug: front/kit\nlicense: cc-by\ntags: ["ui", "saas"]\n---\n# DESIGN.md\n',
    );

    await tool('nexus_design_system_publish').handler({}, context('codex', 'session-1'));

    expect(stubs.publishKit).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'front/kit',
      name: 'Frontmatter Kit',
      license: 'cc-by',
      tags: ['ui', 'saas'],
    }));
  });
});
