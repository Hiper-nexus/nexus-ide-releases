import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
} from '../context/context-workflow-registry';
import { ensureContextScaffold } from '../context/context-doctor';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { GetDesignCliRunner } from '../design/getdesign-cli-source';
import { DESIGN_KIT_SOURCES } from '../design/design-kit-source';
import type { DesignSystemImportAttempt } from '../../shared/surface-payload-types';
import type { AgentGateContext } from './gate';
import { DEFAULT_DESIGN_TARGET_PATH } from './design-system-authority';
import {
  fallbackKitIdFromIdentifier,
  importDesignContractWithKeylessFallback,
  isMissingDesignCredentialError,
} from './design-system-import-fallback';

let baseDir = '';
let root = '';
let catalogDir = '';
let cliDir = '';
let manager: ProjectRuntimeManager;
let scope: ProjectExecutionScope;

const LINEAR = '---\nname: Linear-design-analysis\n---\n\n## Colors\ncanvas: #010102\n';
const RAYCAST = '---\nname: Raycast-design-analysis\n---\n\n## Colors\ncanvas: #0d0d0e\n';

function context(): AgentGateContext {
  return {
    token: 'token-renderer',
    label: 'user',
    role: 'user',
    sessionId: 'renderer-1',
    agentName: 'user',
    providerId: 'user',
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

/** Mirrors DesignMdAuthError without importing the electron-touching client. */
function authError(message = 'DesignMd API key not configured'): Error {
  const error = new Error(message);
  error.name = 'DesignMdAuthError';
  return error;
}

const getDesignRunner: GetDesignCliRunner = async ({ args }) => {
  if (args[0] === 'list') return { stdout: 'raycast\n', stderr: '', code: 0 };
  const outIndex = args.indexOf('--out');
  const brand = args[1];
  if (brand !== 'raycast') return { stdout: '', stderr: 'unknown brand', code: 1 };
  if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], RAYCAST);
  return { stdout: '', stderr: '', code: 0 };
};

function options() {
  return {
    assertCurrentAuthority: () => {},
    localDesignCatalogDir: catalogDir,
    getDesignSourceOptions: {
      runCli: getDesignRunner,
      workDirFactory: () => fs.mkdtempSync(path.join(cliDir, 'run-')),
    },
  };
}

function runImport(
  identifier: string,
  runRemoteImport: () => Promise<Record<string, unknown>>,
) {
  return importDesignContractWithKeylessFallback({
    ctx: context(),
    identifier,
    targetPath: DEFAULT_DESIGN_TARGET_PATH,
    assertCurrentAuthority: () => {},
    runRemoteImport,
    options: options(),
  });
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-fallback-runtime-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-fallback-')));
  catalogDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-fallback-catalog-')),
  );
  cliDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-design-fallback-cli-')),
  );
  fs.writeFileSync(path.join(catalogDir, 'linear.md'), LINEAR);
  scope = Object.freeze({
    version: 1,
    installationId: 'installation-fallback',
    projectId: 'project-fallback',
    checkoutId: 'checkout-fallback',
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

/**
 * Compile-time guard: the renderer payload union must name exactly the sources
 * the main process can serve, or the button could report a source the UI has no
 * word for. Assigning both ways fails the build on any drift.
 */
const _payloadCoversEverySource: readonly DesignSystemImportAttempt['sourceId'][] =
  DESIGN_KIT_SOURCES;
const _everySourceIsAPayloadSource: readonly (typeof DESIGN_KIT_SOURCES)[number][] =
  [] as DesignSystemImportAttempt['sourceId'][];
void _payloadCoversEverySource;
void _everySourceIsAPayloadSource;

describe('fallbackKitIdFromIdentifier', () => {
  it('takes the slug from author/slug and from a designmd.ai URL', () => {
    expect(fallbackKitIdFromIdentifier('acme/linear')).toBe('linear');
    expect(fallbackKitIdFromIdentifier('https://designmd.ai/kits/acme/linear')).toBe(
      'linear',
    );
    expect(fallbackKitIdFromIdentifier('Raycast')).toBe('raycast');
    expect(fallbackKitIdFromIdentifier('acme/linear?ref=x#top')).toBe('linear');
  });

  it('refuses identifiers that are not usable kit ids', () => {
    expect(fallbackKitIdFromIdentifier('   ')).toBeNull();
    expect(fallbackKitIdFromIdentifier('acme/..')).toBeNull();
    expect(fallbackKitIdFromIdentifier('acme/-leading')).toBeNull();
    expect(fallbackKitIdFromIdentifier(`acme/${'a'.repeat(65)}`)).toBeNull();
  });
});

describe('isMissingDesignCredentialError', () => {
  it('recognizes the designmd auth error and nothing else', () => {
    expect(isMissingDesignCredentialError(authError())).toBe(true);
    expect(isMissingDesignCredentialError(new Error('fetch failed'))).toBe(false);
    expect(isMissingDesignCredentialError('DesignMdAuthError')).toBe(false);
  });
});

describe('importDesignContractWithKeylessFallback', () => {
  it('keeps the remote import when it succeeds and never touches the fallback', async () => {
    const result = await runImport('acme/linear', async () => ({
      draftId: 'draft-remote',
      targetPath: DEFAULT_DESIGN_TARGET_PATH,
      status: 'proposed',
    }));

    expect(result.servedBy).toBe('designmd.ai');
    expect(result.draft.draftId).toBe('draft-remote');
    expect(result.attempts).toEqual([
      { sourceId: 'designmd.ai', ok: true, detail: null },
    ]);
  });

  it('falls back to the local catalog when the remote import has no credential', async () => {
    const result = await runImport('acme/linear', async () => {
      throw authError();
    });

    expect(result.servedBy).toBe('local-catalog');
    expect(result.draft.sourceId).toBe('local-catalog');
    expect(result.draft.kitId).toBe('linear');
    expect(typeof result.draft.draftId).toBe('string');
    expect(result.draft.status).toBe('proposed');
    expect(result.attempts[0]).toMatchObject({ sourceId: 'designmd.ai', ok: false });
    expect(result.attempts[0].detail).toContain('DesignMd API key not configured');
    expect(result.attempts.at(-1)).toEqual({
      sourceId: 'local-catalog',
      ok: true,
      detail: null,
    });
  });

  it('falls through the local catalog to the open getdesign catalog', async () => {
    const result = await runImport('acme/raycast', async () => {
      throw authError();
    });

    expect(result.servedBy).toBe('getdesign');
    expect(result.draft.sourceId).toBe('getdesign');
    expect(result.draft.kitId).toBe('raycast');
    expect(result.attempts.map((attempt) => attempt.sourceId)).toEqual([
      'designmd.ai',
      'local-catalog',
      'getdesign',
    ]);
    expect(result.attempts[1]).toMatchObject({ sourceId: 'local-catalog', ok: false });
  });

  it('rethrows a real remote failure instead of silently importing another kit', async () => {
    await expect(
      runImport('acme/linear', async () => {
        throw new Error('DesignMd API returned 404');
      }),
    ).rejects.toThrow('DesignMd API returned 404');
  });

  it('fails visibly when no source has the kit, naming every attempt', async () => {
    await expect(
      runImport('acme/nonexistent', async () => {
        throw authError();
      }),
    ).rejects.toThrow(/nonexistent[\s\S]*designmd\.ai[\s\S]*local-catalog[\s\S]*getdesign/);
  });

  it('refuses to guess a kit id the identifier cannot yield', async () => {
    await expect(
      runImport('acme/..', async () => {
        throw authError();
      }),
    ).rejects.toThrow(/no keyless fallback/);
  });

  it('stops on a revoked authority instead of trying the next source', async () => {
    await expect(
      importDesignContractWithKeylessFallback({
        ctx: context(),
        identifier: 'acme/linear',
        targetPath: DEFAULT_DESIGN_TARGET_PATH,
        assertCurrentAuthority: () => {
          throw new Error('renderer workspace scope changed');
        },
        runRemoteImport: async () => {
          throw authError();
        },
        options: options(),
      }),
    ).rejects.toThrow('renderer workspace scope changed');
  });
});
