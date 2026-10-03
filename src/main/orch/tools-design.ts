import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { recordVisualHandoffEvidence } from './visual-handoff-gate';
import {
  browserDesignSessionKey,
  captureBrowserScreenshot,
} from '../browser/browser-manager';
import {
  getDesignAnnotationSummaries,
  getLastSelection,
  getSelections,
  isDesignModeActive,
} from '../browser/design-session';
import {
  queryFromSelection,
  searchWorkspaceForSelection,
} from './design-code-search';
import { authorizePaneRef, requireStr, str } from './tool-util';
import { resolveCwdForScope } from './workspace-path';

/**
 * Design-mode MCP tools (VISUAL-EDIT-001, Fase 1). The selection is produced
 * by the in-page picker and stored per pane in design-session; this tool is
 * the PULL surface for agents (the push flow — "enviar seleção pro agente" —
 * lives in design-send.ts). Same authz seam as every browser tool.
 */

const designSelectionGetTool: McpToolDef = {
  name: 'nexus_design_selection_get',
  description:
    'Read the current design-mode selection of a browser pane: L0 DOM context ' +
    '(tag/classes/selector/styles, redacted), L1 framework hints when the page ' +
    'runs a dev build, and top workspace code candidates (file:line, scored). ' +
    'Set includeScreenshot for an element PNG. Also lists the pane’s design ' +
    'annotations (numbered user feedback pinned on elements) when any exist.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: { type: 'string' },
      dir: {
        type: 'string',
        description: 'Workspace-relative root for the code search (default: workspace)',
      },
      includeScreenshot: { type: 'boolean' },
    },
    required: ['paneId'],
  },
  handler: async (args, ctx, invocation) => {
    const paneId = requireStr(args, 'paneId');
    authorizePaneRef(ctx, paneId, 'read');
    const sessionKey = browserDesignSessionKey(ctx.scope, paneId);
    const selection = getLastSelection(sessionKey);
    // Annotations outlive the picker session (design mode off keeps them), so
    // a pane with pinned feedback is still a meaningful read without a live
    // selection — only the fully-empty case fails.
    const annotations = getDesignAnnotationSummaries(sessionKey);
    if (!selection && annotations.length === 0) {
      throw new Error(
        'no design selection for this pane: enable design mode on the browser ' +
          'pane and click an element first',
      );
    }

    let candidates: Awaited<ReturnType<typeof searchWorkspaceForSelection>> = [];
    if (selection) {
      try {
        const workspaceDir = resolveCwdForScope(ctx.scope, str(args, 'dir'));
        candidates = await searchWorkspaceForSelection(
          workspaceDir,
          queryFromSelection(selection),
        );
      } catch {
        // L2 is advisory: an unresolvable workspace never blocks the selection.
      }
    }

    const visualAssignment = ctx.visualTask;
    let screenshot;
    if (args.includeScreenshot === true && selection) {
      try {
        screenshot = await captureBrowserScreenshot(
          paneId,
          ctx.scope,
          ctx.missionId,
          { clip: selection.rect, signal: invocation?.signal, assertCurrentAuthority: invocation?.assertCurrentAuthority },
        );
        assertMcpInvocationCurrent(invocation);
        if (ctx.visualTask === visualAssignment) recordVisualHandoffEvidence(ctx, screenshot.artifactId);
      } catch {
        // Hidden/destroyed panes degrade to a context-only result.
      }
    }

    assertMcpInvocationCurrent(invocation);
    const selections = getSelections(sessionKey);
    return {
      paneId,
      designModeActive: isDesignModeActive(sessionKey),
      // Stable shape: consumers branch on VALUES, not key existence.
      selection: selection ?? null,
      // Multi-selection set (F4); a single click yields a one-element list.
      ...(selections.length > 1 ? { selections } : {}),
      candidates,
      annotations,
      ...(screenshot ? { screenshot } : {}),
    };
  },
};

export function buildDesignTools(): McpToolDef[] {
  return [designSelectionGetTool];
}
