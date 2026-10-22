import { ipcRenderer, webFrame } from 'electron';
import {
  BROWSER_AUTOMATION_CHANNELS,
  type BrowserAutomationCommand,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
} from '../shared/browser-automation';
import { BROWSER_DESIGN_CHANNELS } from '../shared/browser-design';
import { createBrowserAutomation } from './browser-automation';

const REQUEST_ID = /^[a-f0-9-]{16,64}$/i;
// Must stay in sync with the BrowserAutomationCommand union (shared/
// browser-automation.ts). Each command's own input guards live in
// browser-automation.ts (e.g. press key/modifier allowlists, ref validation);
// this set only decides which commands the closed channel will dispatch.
const COMMANDS = new Set<BrowserAutomationCommand>([
  'read',
  'inspect',
  'find',
  'click',
  'input_prepare',
  'input_confirm',
  'fill',
  'wait',
  'scroll',
  'press',
  'hover',
  'extract_candidates',
  'layout_audit',
  'visual_masks',
  'design_enable',
  'design_disable',
  'design_set_style_preview',
  'design_clear_style_preview',
  'design_set_annotation_markers',
]);
const MAX_ARGS_BYTES = 16 * 1024;

function parseRequest(raw: unknown): BrowserAutomationRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) {
    return null;
  }
  if (typeof input.command !== 'string' || !COMMANDS.has(input.command as BrowserAutomationCommand)) {
    return null;
  }
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
    return null;
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(input.args)).byteLength > MAX_ARGS_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    requestId: input.requestId,
    command: input.command as BrowserAutomationCommand,
    args: input.args as Record<string, unknown>,
  };
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'browser automation failed';
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 512);
}

const automation = createBrowserAutomation(window, {
  // Design-mode picker events (selection/mode) are page→main PUSH: no pending
  // request to answer, so they ride their own closed channel.
  onDesignEvent: (event) => {
    ipcRenderer.send(BROWSER_DESIGN_CHANNELS.event, event);
  },
  // L1 bridge: framework expandos live in the MAIN world only (spike Fase
  // 0.4). Runs like the DevTools console — not blocked by the page's CSP.
  evalInMainWorld: (source) => webFrame.executeJavaScript(source),
});

const pendingPresses = new Map<string, AbortController>();
ipcRenderer.on(BROWSER_AUTOMATION_CHANNELS.cancel, (_event, requestId: unknown) => {
  if (typeof requestId === 'string' && REQUEST_ID.test(requestId)) pendingPresses.get(requestId)?.abort();
});

ipcRenderer.on(BROWSER_AUTOMATION_CHANNELS.request, (_event, raw: unknown) => {
  const request = parseRequest(raw);
  if (!request) return;
  const controller = request.command === 'press' ? new AbortController() : undefined;
  if (controller) pendingPresses.set(request.requestId, controller);
  void automation
    .run(request.command, request.args, controller ? { signal: controller.signal } : undefined)
    .then((result) => {
      const response: BrowserAutomationResponse = {
        requestId: request.requestId,
        ok: true,
        result,
      };
      ipcRenderer.send(BROWSER_AUTOMATION_CHANNELS.response, response);
    })
    .catch((err) => {
      const response: BrowserAutomationResponse = {
        requestId: request.requestId,
        ok: false,
        error: safeError(err),
      };
      ipcRenderer.send(BROWSER_AUTOMATION_CHANNELS.response, response);
    })
    .finally(() => { pendingPresses.delete(request.requestId); });
});
