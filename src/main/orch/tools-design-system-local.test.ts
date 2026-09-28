import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
  getContextKnowledgeService,
} from '../context/context-workflow-registry';
import { ensureContextScaffold } from '../context/context-doctor';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { GetDesignCliRunner } from '../design/getdesign-cli-source';
import type { AgentGateContext } from './gate';
import type { DesignSystemToolOptions } from './design-system-authority';
import { OUTSIDE_HOME_LABEL, homeRelativePath } from './home-relative-path';
import { buildKeylessDesignSystemTools } from './tools-design-system-local';

let baseDir = '';
let root = '';
let catalogDir = '';
let cliDir = '';
let manager: ProjectRuntimeManager;
let scope: ProjectExecutionScope;

const LINEAR = [
  '---',
  'name: Linear-design-analysis',
  'description: "Near-black canvas with a single lavender accent."',
  '---',
  '',
  '## Colors',
  'canvas: #010102',
  '',
].join('\n');

const RAYCAST = '---\nname: Raycast-design-analysis\n---\n\n## Colors\ncanvas: #0d0d0e\n';

function context(
  role: AgentGateContext['role'] = 'orchestrator',
  sessionId = 'session-1',
): AgentGateContext {
  return {
    token: `token-${sessionId}`,
    label: 'codex',
    role,
    sessionId,
    agentName: 'codex-agent',
    providerId: 'codex',
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function baseOptions(): DesignSystemToolOptions {
  return {
    assertCurrentAuthority: () => {},
    localDesignCatalogDir: catalogDir,
  };
}

function tool(name: string, options: DesignSystemToolOptions = baseOptions()) {
  const found = buildKeylessDesignSystemTools(options).find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

const getDesignRunner: GetDesignCliRunner = async ({ args }) => {
  if (args[0] === 'list') return { stdout: 'raycast\nstripe\n', stderr: '', code: 0 };
  const outIndex = args.indexOf('--out');
  if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], RAYCAST);
  return { stdout: '', stderr: '', code: 0 };
};

function getDesignOptions(): DesignSystemToolOptions {
  return {
    ...baseOptions(),
    getDesignSourceOptions: {
      runCli: getDesignRunner,
      workDirFactory: () => fs.mkdtempSync(path.join(cliDir, 'run-')),
    },
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-keyless-design-runtime-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-keyless-design-')));
  catalogDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-keyless-catalog-')),
  );
  cliDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-keyless-cli-')));
  fs.writeFileSync(path.join(catalogDir, 'linear.md'), LINEAR);
  fs.writeFileSync(path.join(catalogDir, 'README.md'), '# Design References\n');
  scope = Object.freeze({
    version: 1,
    installationId: 'installation-keyless',
    projectId: 'project-keyless',
    checkoutId: 'checkout-keyless',
    rootRealPath: root,
    identitySource: 'manifest',
  });
  manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  configureContextWorkflowRegistry(manager, { appVersion: 'test' });
  ensureContextScaffold(scope);
});

afterEach(() => {
  disposeContextWorkflowRegistry();
  manager.closeAll();
  for (const dir of [root, baseDir, catalogDir, cliDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('nexus_design_system_local_list', () => {
  it('lists local kits without an API key and ignores the README index', async () => {
    const result = (await tool('nexus_design_system_local_list').handler(
      {},
      context(),
    )) as {
      sourceId: string;
      requiresApiKey: boolean;
      dir: string;
      count: number;
      kits: Array<{ kitId: string; title: string }>;
      skipped: Array<{ fileName: string; reason: string }>;
    };

    expect(result.sourceId).toBe('local-catalog');
    expect(result.requiresApiKey).toBe(false);
    // The absolute path carries the OS account name and is never handed to an
    // agent: a catalog under home reads `~/.design-references`, and one outside
    // home is labelled instead of printed. See home-relative-path.test.ts.
    expect(result.dir).toBe(homeRelativePath(catalogDir));
    if (process.platform === 'win32') {
      // O temp do Windows mora no perfil do usuário (%USERPROFILE%\AppData):
      // sai relativo ao home, nunca com o nome da conta.
      expect(result.dir).toMatch(/^~\//);
    } else {
      expect(result.dir).toBe(OUTSIDE_HOME_LABEL);
    }
    expect(result.dir).not.toContain(catalogDir);
    expect(result.kits.map((kit) => kit.kitId)).toEqual(['linear']);
    expect(result.kits[0].title).toBe('Linear-design-analysis');
    expect(result.skipped).toContainEqual({
      fileName: 'README.md',
      reason: 'index-file',
    });
  });

  it('lists the open getdesign catalog and flags a fallback roster', async () => {
    const result = (await tool(
      'nexus_design_system_local_list',
      getDesignOptions(),
    ).handler({ source: 'getdesign' }, context())) as {
      sourceId: string;
      isFallbackList: boolean;
      kits: Array<{ kitId: string }>;
    };

    expect(result.sourceId).toBe('getdesign');
    expect(result.isFallbackList).toBe(false);
    expect(result.kits.map((kit) => kit.kitId)).toEqual(['raycast', 'stripe']);
  });

  it('rejects an unknown source instead of silently using the local one', async () => {
    await expect(
      tool('nexus_design_system_local_list').handler(
        { source: 'designmd.ai' },
        context(),
      ),
    ).rejects.toThrow(/unknown keyless design kit source/i);
  });

  it('rejects workers', async () => {
    await expect(
      tool('nexus_design_system_local_list').handler({}, context('worker')),
    ).rejects.toThrow(/workers cannot enumerate design catalogs/i);
  });
});

describe('nexus_design_system_local_import', () => {
  it('proposes a draft carrying provenance and the adaptation rule', async () => {
    const result = (await tool('nexus_design_system_local_import').handler(
      { kitId: 'linear' },
      context(),
    )) as {
      draftId: string;
      targetPath: string;
      status: string;
      evidencePath: string;
      sourceId: string;
      kitId: string;
      contentHash: string;
    };

    expect(result.status).toBe('proposed');
    expect(result.targetPath).toBe('.context/docs/design-system.md');
    expect(result.sourceId).toBe('local-catalog');
    expect(result.kitId).toBe('linear');

    // The authority file itself must NOT be written by the import.
    expect(fs.existsSync(path.join(root, result.targetPath))).toBe(false);
    expect(fs.existsSync(path.join(root, 'DESIGN.md'))).toBe(false);

    const draft = getContextKnowledgeService(scope).get(result.draftId);
    expect(draft).not.toBeNull();
    expect(draft!.content).toContain('kit-source: local-catalog | kit: linear');
    expect(draft!.content).toContain('origin: linear.md');
    expect(draft!.content).toContain(`sha256: ${result.contentHash}`);
    expect(draft!.content).toContain('ADAPTED');
    expect(draft!.content).toContain(
      'Never copy a third-party brand, logo, or wordmark.',
    );
    expect(draft!.content).toContain('PROPOSED context draft');
    expect(draft!.content).toContain('canvas: #010102');

    const evidence = JSON.parse(
      fs.readFileSync(path.join(root, result.evidencePath), 'utf8'),
    ) as Record<string, unknown>;
    expect(evidence.source).toBe('local-catalog');
    expect(evidence.kitId).toBe('linear');
    expect(evidence.locator).toBe('linear.md');
    expect(evidence.contentHash).toBe(result.contentHash);
  });

  it('imports from the open getdesign catalog with its own provenance', async () => {
    const result = (await tool(
      'nexus_design_system_local_import',
      getDesignOptions(),
    ).handler({ kitId: 'raycast', source: 'getdesign' }, context())) as {
      draftId: string;
      sourceId: string;
    };

    expect(result.sourceId).toBe('getdesign');
    const draft = getContextKnowledgeService(scope).get(result.draftId);
    expect(draft!.content).toContain('kit-source: getdesign | kit: raycast');
    expect(draft!.content).toContain('origin: getdesign:raycast');
    expect(draft!.content).toContain('canvas: #0d0d0e');
  });

  it('rejects import by workers', async () => {
    await expect(
      tool('nexus_design_system_local_import').handler(
        { kitId: 'linear' },
        context('worker'),
      ),
    ).rejects.toThrow(/workers cannot propose context authority drafts/i);
    expect(getContextKnowledgeService(scope).list({ status: 'proposed' })).toEqual([]);
  });

  it('refuses when the workspace already has a contract, unless forced', async () => {
    fs.writeFileSync(path.join(root, 'DESIGN.md'), '# Existing contract\n');

    await expect(
      tool('nexus_design_system_local_import').handler({ kitId: 'linear' }, context()),
    ).rejects.toThrow(/already has a design contract at DESIGN\.md/i);
    expect(getContextKnowledgeService(scope).list({ status: 'proposed' })).toEqual([]);

    const forced = (await tool('nexus_design_system_local_import').handler(
      { kitId: 'linear', force: true },
      context(),
    )) as { status: string };
    expect(forced.status).toBe('proposed');
  });

  it('refuses an unknown kit id', async () => {
    await expect(
      tool('nexus_design_system_local_import').handler({ kitId: 'stripe' }, context()),
    ).rejects.toThrow(/local design kit not found: stripe/i);
  });

  it('writes no evidence or draft when authority is revoked mid-import', async () => {
    let live = true;
    const importTool = tool('nexus_design_system_local_import', {
      ...baseOptions(),
      assertCurrentAuthority: () => {
        if (!live) throw new Error('renderer workspace authority changed');
      },
      getDesignSourceOptions: {
        runCli: async ({ args }) => {
          live = false;
          const outIndex = args.indexOf('--out');
          if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], RAYCAST);
          return { stdout: '', stderr: '', code: 0 };
        },
        workDirFactory: () => fs.mkdtempSync(path.join(cliDir, 'run-')),
      },
    });

    await expect(
      importTool.handler({ kitId: 'raycast', source: 'getdesign' }, context()),
    ).rejects.toThrow(/workspace authority changed/i);
    expect(
      fs.existsSync(path.join(root, '.context', 'nexus', 'evidence', 'design-catalog')),
    ).toBe(false);
    expect(getContextKnowledgeService(scope).list({ status: 'proposed' })).toEqual([]);
  });
});
