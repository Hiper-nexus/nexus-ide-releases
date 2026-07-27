import {
  assertBrowserAtExactUrl,
  destroyBrowserWithProof,
  loadBrowser,
  lockBrowserToExactUrl,
  readBrowserPage,
} from '../browser/browser-manager';
import {
  getPaneAuthzInfo,
  requestBrowserPane,
  requestPaneClose,
} from '../orch/pane-registry';
import {
  isRunningPreviewDescriptorForScope,
  listPreviews,
  startPreview,
  stopPreviewWithProof,
} from '../orch/preview-server';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from '../orch/mcp-protocol';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AutomatedReviewDesignSurface } from './automated-review-session';
import {
  realpathAutomatedReviewPreviewDirectory,
  resolveAutomatedReviewPreviewRoot,
} from './automated-review-preview';

export interface PrepareAutomatedReviewDesignSurfaceInput {
  readonly reviewSessionId: string;
  readonly missionId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly executionScope: Readonly<ProjectExecutionScope>;
  readonly invocation: McpToolInvocation;
}

const provisionedPreviewByPane = new Map<string, string>();

async function resolveOrProvisionPreview(
  input: PrepareAutomatedReviewDesignSurfaceInput,
): Promise<{
  readonly preview: ReturnType<typeof listPreviews>[number];
  readonly provisioned: boolean;
}> {
  const artifact = resolveAutomatedReviewPreviewRoot(
    input.executionScope.rootRealPath,
  );
  const previews = listPreviews(input.scope).filter((preview) =>
    isRunningPreviewDescriptorForScope(
      preview.id,
      preview.url,
      input.executionScope,
    ),
  );
  if (previews.length > 1) {
    throw new Error(
      `rendered design review requires exactly one Nexus-owned local preview ` +
        `inside the candidate checkout; found ${previews.length}`,
    );
  }
  if (previews.length === 1) {
    const preview = previews[0]!;
    if (
      realpathAutomatedReviewPreviewDirectory(preview.dir) === artifact.root
    ) {
      return { preview, provisioned: false };
    }
  }

  assertMcpInvocationCurrent(input.invocation);
  const started = await startPreview(
    artifact.root,
    input.scope,
    input.invocation,
  );
  assertMcpInvocationCurrent(input.invocation);
  if (
    !isRunningPreviewDescriptorForScope(
      started.id,
      started.url,
      input.executionScope,
    )
  ) {
    await stopPreviewWithProof(started.id, input.scope);
    throw new Error(
      'main-provisioned design preview did not bind to the candidate checkout',
    );
  }
  return {
    preview: {
      id: started.id,
      dir: artifact.root,
      url: started.url,
    },
    provisioned: true,
  };
}

/**
 * Main provisions the render before any reviewer token exists. A design review
 * therefore receives one already-loaded local pane, never process authority or
 * a general browser-navigation capability.
 */
export async function prepareAutomatedReviewDesignSurface(
  input: PrepareAutomatedReviewDesignSurfaceInput,
): Promise<AutomatedReviewDesignSurface> {
  assertMcpInvocationCurrent(input.invocation);
  let previewId: string | null = null;
  let provisioned = false;
  let paneId: string | null = null;
  try {
    const resolved = await resolveOrProvisionPreview(input);
    const preview = resolved.preview;
    previewId = preview.id;
    provisioned = resolved.provisioned;
    const opened = await requestBrowserPane({
      url: 'about:blank',
      title: `design-review-${input.missionId}`,
      missionId: input.missionId,
      agentName:
        `automated-review-surface-` +
        input.reviewSessionId.replaceAll('-', '').slice(0, 12),
      scope: input.scope,
    });
    if (!opened.ok || !opened.paneId) {
      throw new Error(
        opened.error ?? 'automated design-review browser open failed',
      );
    }
    paneId = opened.paneId;
    assertMcpInvocationCurrent(input.invocation);
    const state = await loadBrowser(paneId, preview.url, {
      scope: input.scope,
      signal: input.invocation.signal,
      assertCurrentAuthority: input.invocation.assertCurrentAuthority,
    });
    assertMcpInvocationCurrent(input.invocation);
    if (state.error) {
      throw new Error(`automated design-review preview failed: ${state.error}`);
    }
    lockBrowserToExactUrl(paneId, input.scope, preview.url);
    // Prove that the browser preload/automation channel can inspect this
    // document before granting it to reviewer bearers.
    assertBrowserAtExactUrl(paneId, input.scope, preview.url);
    const readable = await readBrowserPage(paneId, input.scope, {
      maxChars: 1,
      maxElements: 1,
    });
    assertMcpInvocationCurrent(input.invocation);
    assertBrowserAtExactUrl(paneId, input.scope, preview.url);
    if (readable.url !== preview.url) {
      throw new Error(
        'automated design-review preload read came from another URL',
      );
    }
    if (provisioned) {
      provisionedPreviewByPane.set(paneId, preview.id);
    }
    return Object.freeze({
      paneId,
      previewId: preview.id,
      url: preview.url,
      missionId: input.missionId,
      scope: Object.freeze({ ...input.scope }),
      executionScope: Object.freeze({ ...input.executionScope }),
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (paneId) {
      try {
        await closeAutomatedReviewDesignSurface({
          paneId,
          scope: input.scope,
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (provisioned && previewId) {
      try {
        const stopped = await stopPreviewWithProof(previewId, input.scope);
        if (!stopped) {
          throw new Error(
            `design-review preview ${previewId} has no physical teardown proof`,
          );
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupError = cleanupErrors[0];
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `design-review cleanup failed: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function closeAutomatedReviewDesignSurface(input: {
  readonly paneId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
}): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await destroyBrowserWithProof(input.paneId, input.scope);
  } catch (error) {
    cleanupErrors.push(error);
  }
  let closeRequested = false;
  try {
    closeRequested = await requestPaneClose(input.paneId);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (!closeRequested && getPaneAuthzInfo(input.paneId)) {
    cleanupErrors.push(
      new Error(
        `design-review browser pane ${input.paneId} could not be detached from its owner`,
      ),
    );
  }
  const previewId = provisionedPreviewByPane.get(input.paneId);
  if (previewId) {
    try {
      const stopped = await stopPreviewWithProof(previewId, input.scope);
      if (!stopped) {
        throw new Error(
          `design-review preview ${previewId} has no physical teardown proof`,
        );
      }
      provisionedPreviewByPane.delete(input.paneId);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    const [first, ...rest] = cleanupErrors;
    throw new Error(
      [
        first instanceof Error ? first.message : String(first),
        ...rest.map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
      ].join('; '),
      { cause: first },
    );
  }
}
