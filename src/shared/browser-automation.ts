/**
 * Dependency-free contract between the main process and the isolated preload
 * used by embedded browser panes. Remote pages never receive this surface.
 */

export const BROWSER_AUTOMATION_CHANNELS = {
  request: 'browser:automation-request',
  response: 'browser:automation-response',
} as const;

export type BrowserAutomationCommand =
  | 'read'
  | 'inspect'
  | 'click'
  | 'fill'
  | 'wait'
  | 'scroll'
  | 'press'
  | 'hover'
  | 'design_enable'
  | 'design_disable'
  | 'design_set_style_preview'
  | 'design_clear_style_preview'
  | 'design_set_annotation_markers';

export interface BrowserAutomationRequest {
  requestId: string;
  command: BrowserAutomationCommand;
  args: Record<string, unknown>;
}

export interface BrowserAutomationResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BrowserElementDescriptor {
  ref: string;
  tag: string;
  role: string;
  name: string;
  href?: string;
  inputType?: string;
  disabled?: boolean;
  checked?: boolean;
  editable?: boolean;
}

export interface BrowserPageReadResult {
  url: string;
  title: string;
  readyState: string;
  language?: string;
  description?: string;
  bodyText: string;
  headings: Array<{ level: number; text: string }>;
  elements: BrowserElementDescriptor[];
  truncated: boolean;
}

export type BrowserWaitCondition = 'load' | 'text' | 'ref';
