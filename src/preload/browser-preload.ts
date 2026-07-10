import { ipcRenderer } from 'electron';
import {
  BROWSER_AUTOMATION_CHANNELS,
  type BrowserAutomationCommand,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
} from '../shared/browser-automation';
import { createBrowserAutomation } from './browser-automation';

const REQUEST_ID = /^[a-f0-9-]{16,64}$/i;
const COMMANDS = new Set<BrowserAutomationCommand>([
  'read',
  'inspect',
  'click',
  'fill',
  'wait',
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

const automation = createBrowserAutomation(window);

ipcRenderer.on(BROWSER_AUTOMATION_CHANNELS.request, (_event, raw: unknown) => {
  const request = parseRequest(raw);
  if (!request) return;
  void automation
    .run(request.command, request.args)
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
    });
});
