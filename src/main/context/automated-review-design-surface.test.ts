import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  previews: [] as Array<{ id: string; dir: string; url: string }>,
  descriptorValid: true,
  realpathPreviewDirectory: vi.fn((directory: string) => directory),
  resolvePreviewRoot: vi.fn(() => ({
    root: '/candidate/dist',
    indexPath: '/candidate/dist/index.html',
    relativeRoot: 'dist',
    kind: 'built-output' as const,
  })),
  startPreview: vi.fn(async () => ({
    id: 'preview-provisioned',
    url: 'http://127.0.0.1:1234/',
    port: 1234,
  })),
  stopPreviewWithProof: vi.fn(async () => true),
  requestBrowserPane: vi.fn(async () => ({
    ok: true,
    paneId: 'browser-review',
  })),
  requestPaneClose: vi.fn(async () => true),
  getPaneAuthzInfo: vi.fn(() => null as object | null),
  loadBrowser: vi.fn(async () => ({
    paneId: 'browser-review',
    url: 'http://127.0.0.1:1234/',
    error: undefined as string | undefined,
  })),
  readBrowserPage: vi.fn(async () => ({
    paneId: 'browser-review',
    url: 'http://127.0.0.1:1234/',
  })),
  assertBrowserAtExactUrl: vi.fn(),
  lockBrowserToExactUrl: vi.fn(),
  destroyBrowserWithProof: vi.fn(async () => undefined),
}));

vi.mock('../orch/preview-server', () => ({
  listPreviews: vi.fn(() => stubs.previews),
  startPreview: stubs.startPreview,
  stopPreviewWithProof: stubs.stopPreviewWithProof,
  isRunningPreviewDescriptorForScope: vi.fn(
    () => stubs.descriptorValid,
  ),
}));
vi.mock('./automated-review-preview', () => ({
  realpathAutomatedReviewPreviewDirectory:
    stubs.realpathPreviewDirectory,
  resolveAutomatedReviewPreviewRoot: stubs.resolvePreviewRoot,
}));
vi.mock('../orch/pane-registry', () => ({
  requestBrowserPane: stubs.requestBrowserPane,
  requestPaneClose: stubs.requestPaneClose,
  getPaneAuthzInfo: stubs.getPaneAuthzInfo,
}));
vi.mock('../browser/browser-manager', () => ({
  loadBrowser: stubs.loadBrowser,
  readBrowserPage: stubs.readBrowserPage,
  assertBrowserAtExactUrl: stubs.assertBrowserAtExactUrl,
  lockBrowserToExactUrl: stubs.lockBrowserToExactUrl,
  destroyBrowserWithProof: stubs.destroyBrowserWithProof,
}));

import {
  closeAutomatedReviewDesignSurface,
  prepareAutomatedReviewDesignSurface,
} from './automated-review-design-surface';
import { testProjectScope } from '../orch/__tests__/scope-fixture';

const scope = testProjectScope({ rootRealPath: '/workspace' });
const executionScope = Object.freeze({
  ...scope,
  rootRealPath: '/candidate',
});
const invocation = {};

describe('automated review design surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubs.previews = [];
    stubs.descriptorValid = true;
    stubs.realpathPreviewDirectory.mockImplementation(
      (directory) => directory,
    );
    stubs.resolvePreviewRoot.mockReturnValue({
      root: '/candidate/dist',
      indexPath: '/candidate/dist/index.html',
      relativeRoot: 'dist',
      kind: 'built-output',
    });
    stubs.startPreview.mockResolvedValue({
      id: 'preview-provisioned',
      url: 'http://127.0.0.1:1234/',
      port: 1234,
    });
    stubs.stopPreviewWithProof.mockResolvedValue(true);
    stubs.requestBrowserPane.mockResolvedValue({
      ok: true,
      paneId: 'browser-review',
    });
    stubs.requestPaneClose.mockResolvedValue(true);
    stubs.getPaneAuthzInfo.mockReturnValue(null);
    stubs.loadBrowser.mockResolvedValue({
      paneId: 'browser-review',
      url: 'http://127.0.0.1:1234/',
      error: undefined,
    });
    stubs.destroyBrowserWithProof.mockResolvedValue(undefined);
  });

  it('loads, locks and proves exactly one process-owned candidate preview', async () => {
    stubs.previews = [{
      id: 'preview-review',
      dir: '/candidate/dist',
      url: 'http://127.0.0.1:1234/',
    }];

    await expect(
      prepareAutomatedReviewDesignSurface({
        reviewSessionId: '11111111-1111-4111-8111-111111111111',
        missionId: 'mission-a',
        scope,
        executionScope,
        invocation,
      }),
    ).resolves.toMatchObject({
      paneId: 'browser-review',
      previewId: 'preview-review',
      missionId: 'mission-a',
      scope,
      executionScope,
    });
    expect(stubs.requestBrowserPane).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'about:blank',
        missionId: 'mission-a',
        scope,
      }),
    );
    expect(stubs.loadBrowser).toHaveBeenCalledWith(
      'browser-review',
      'http://127.0.0.1:1234/',
      expect.objectContaining({ scope }),
    );
    expect(stubs.lockBrowserToExactUrl).toHaveBeenCalledWith(
      'browser-review',
      scope,
      'http://127.0.0.1:1234/',
    );
    expect(stubs.readBrowserPage).toHaveBeenCalledOnce();
  });

  it('provisions one main-owned preview when the candidate has no running preview', async () => {
    const surface = await prepareAutomatedReviewDesignSurface({
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      missionId: 'mission-a',
      scope,
      executionScope,
      invocation,
    });
    expect(surface).toMatchObject({
      paneId: 'browser-review',
      previewId: 'preview-provisioned',
    });
    expect(stubs.resolvePreviewRoot).toHaveBeenCalledWith('/candidate');
    expect(stubs.startPreview).toHaveBeenCalledWith(
      '/candidate/dist',
      scope,
      invocation,
    );
    await closeAutomatedReviewDesignSurface(surface);
  });

  it('does not reuse a preview whose physical directory differs from the canonical artifact', async () => {
    stubs.previews = [{
      id: 'preview-stale',
      dir: '/candidate/build',
      url: 'http://127.0.0.1:1235/',
    }];

    const surface = await prepareAutomatedReviewDesignSurface({
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      missionId: 'mission-a',
      scope,
      executionScope,
      invocation,
    });

    expect(stubs.realpathPreviewDirectory).toHaveBeenCalledWith(
      '/candidate/build',
    );
    expect(stubs.startPreview).toHaveBeenCalledWith(
      '/candidate/dist',
      scope,
      invocation,
    );
    expect(surface.previewId).toBe('preview-provisioned');
    await closeAutomatedReviewDesignSurface(surface);
  });

  it('reuses an alias only when its realpath is the canonical artifact', async () => {
    stubs.previews = [{
      id: 'preview-alias',
      dir: '/candidate/current',
      url: 'http://127.0.0.1:1234/',
    }];
    stubs.realpathPreviewDirectory.mockReturnValue('/candidate/dist');

    const surface = await prepareAutomatedReviewDesignSurface({
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      missionId: 'mission-a',
      scope,
      executionScope,
      invocation,
    });

    expect(surface.previewId).toBe('preview-alias');
    expect(stubs.startPreview).not.toHaveBeenCalled();
  });

  it('resolves the canonical artifact before considering a running preview', async () => {
    stubs.previews = [{
      id: 'preview-review',
      dir: '/candidate/dist',
      url: 'http://127.0.0.1:1234/',
    }];
    stubs.resolvePreviewRoot.mockImplementationOnce(() => {
      throw new Error('multiple UI artifacts: ., dist');
    });

    await expect(
      prepareAutomatedReviewDesignSurface({
        reviewSessionId: '11111111-1111-4111-8111-111111111111',
        missionId: 'mission-a',
        scope,
        executionScope,
        invocation,
      }),
    ).rejects.toThrow(/multiple UI artifacts/i);
    expect(stubs.realpathPreviewDirectory).not.toHaveBeenCalled();
    expect(stubs.requestBrowserPane).not.toHaveBeenCalled();
  });

  it('fails before opening a pane when candidate previews are ambiguous', async () => {
    stubs.previews = [
      {
        id: 'preview-a',
        dir: '/candidate/a',
        url: 'http://127.0.0.1:1234/',
      },
      {
        id: 'preview-b',
        dir: '/candidate/b',
        url: 'http://127.0.0.1:1235/',
      },
    ];
    await expect(
      prepareAutomatedReviewDesignSurface({
        reviewSessionId: '11111111-1111-4111-8111-111111111111',
        missionId: 'mission-a',
        scope,
        executionScope,
        invocation,
      }),
    ).rejects.toThrow(/requires exactly one Nexus-owned local preview/i);
    expect(stubs.requestBrowserPane).not.toHaveBeenCalled();
  });

  it('destroys the privileged WebContents and fails if owner detachment is unproven', async () => {
    await expect(
      closeAutomatedReviewDesignSurface({
        paneId: 'browser-review',
        scope,
      }),
    ).resolves.toBeUndefined();
    expect(stubs.destroyBrowserWithProof).toHaveBeenCalledWith(
      'browser-review',
      scope,
    );

    stubs.requestPaneClose.mockResolvedValue(false);
    stubs.getPaneAuthzInfo.mockReturnValue({ paneId: 'browser-review' });
    await expect(
      closeAutomatedReviewDesignSurface({
        paneId: 'browser-review',
        scope,
      }),
    ).rejects.toThrow(/could not be detached/i);
  });

  it('never reports success when physical browser teardown fails', async () => {
    stubs.destroyBrowserWithProof.mockRejectedValueOnce(
      new Error('WebContents remains alive'),
    );

    await expect(
      closeAutomatedReviewDesignSurface({
        paneId: 'browser-review',
        scope,
      }),
    ).rejects.toThrow(/WebContents remains alive/i);
    expect(stubs.requestPaneClose).toHaveBeenCalledWith('browser-review');
  });

  it('stops a provisioned preview after reviewer browser teardown', async () => {
    const surface = await prepareAutomatedReviewDesignSurface({
      reviewSessionId: '11111111-1111-4111-8111-111111111111',
      missionId: 'mission-a',
      scope,
      executionScope,
      invocation,
    });

    await closeAutomatedReviewDesignSurface(surface);

    expect(stubs.stopPreviewWithProof).toHaveBeenCalledWith(
      'preview-provisioned',
      scope,
    );
  });

  it('tears down a newly provisioned listener when browser creation fails', async () => {
    stubs.requestBrowserPane.mockRejectedValueOnce(
      new Error('browser unavailable'),
    );

    await expect(
      prepareAutomatedReviewDesignSurface({
        reviewSessionId: '11111111-1111-4111-8111-111111111111',
        missionId: 'mission-a',
        scope,
        executionScope,
        invocation,
      }),
    ).rejects.toThrow(/browser unavailable/i);
    expect(stubs.stopPreviewWithProof).toHaveBeenCalledWith(
      'preview-provisioned',
      scope,
    );
  });
});
