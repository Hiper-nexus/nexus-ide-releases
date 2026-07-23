import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  emitBgTaskEvent,
  registerBgTaskEventTarget,
  unregisterBgTaskEventTarget,
} from './bg-task-events';

function renderer(id: number): WebContents & { send: ReturnType<typeof vi.fn> } {
  return {
    id,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

const rendererA = renderer(301);
const rendererB = renderer(302);

afterEach(() => {
  unregisterBgTaskEventTarget(rendererA);
  unregisterBgTaskEventTarget(rendererB);
  clearRendererWorkspaceScope(rendererA);
  clearRendererWorkspaceScope(rendererB);
  vi.clearAllMocks();
});

describe('background task event authority', () => {
  it('notifies only the renderer bound to the exact task scope', () => {
    const scopeA = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: '/workspace/a',
    });
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    bindResolvedRendererWorkspaceScope(rendererA, scopeA);
    bindResolvedRendererWorkspaceScope(rendererB, scopeB);
    registerBgTaskEventTarget(rendererA);
    registerBgTaskEventTarget(rendererB);

    emitBgTaskEvent({
      taskId: 'bg-scope-a',
      command: 'npm test',
      status: 'exited',
      exitCode: 0,
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
      scope: scopeA,
      at: 1,
    });

    expect(rendererA.send).toHaveBeenCalledWith(
      ORCH_CHANNELS.bgTaskEvent,
      expect.not.objectContaining({ scope: expect.anything() }),
    );
    expect(rendererB.send).not.toHaveBeenCalled();
  });
});
