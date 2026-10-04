import type { WebContents } from 'electron';
import { getRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { sameProjectScope } from '../orch/project-scoped-broadcast';
import type { ProjectExecutionScope } from '../../shared/types';
let lease: { wc: WebContents; frame: Electron.WebFrameMain; scope: ProjectExecutionScope; nonce: string; entryUrl: string } | null = null;
/** Main acceptance owns this lease; it cannot be armed via product IPC or env alone. */
export function armPrivateCaptureProbe(wc: WebContents, scope: ProjectExecutionScope, nonce: string, grant: string): () => void {
  if (grant !== 'granted' || lease) throw new Error('existing OS microphone grant required');
  const current = { wc, frame: wc.mainFrame, scope, nonce, entryUrl: wc.getURL?.() ?? '' }; lease = current;
  return () => { if (lease === current) lease = null; };
}
/** Both Electron 43.7.4 permission paths must carry document and audio proof.
 * An omitted/mixed media type never grants access or prompts for a camera. */
export function privateCaptureMediaPermission(sender: WebContents | null, permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string; securityOrigin?: string; mediaTypes?: readonly string[]; mediaType?: string },
  kind: 'request' | 'check', grant: string): boolean {
  const current = lease;
  if (!current || sender !== current.wc || permission !== 'media' || grant !== 'granted' || !privateCaptureProbeAllowed(sender, current.frame) ||
      !current.entryUrl || sender.getURL() !== current.entryUrl || current.frame.url !== current.entryUrl ||
      details.isMainFrame !== true || details.requestingUrl !== current.entryUrl) return false;
  const entry = new URL(current.entryUrl);
  if (entry.protocol !== 'nexus-app:' || details.securityOrigin !== `${entry.protocol}//${entry.host}`) return false;
  return kind === 'request' ? details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio' : details.mediaType === 'audio';
}
export function privateCaptureProbeAllowed(sender?: WebContents, senderFrame?: Electron.WebFrameMain | null): boolean {
  const current = lease;
  if (!current || sender && (sender !== current.wc || senderFrame !== current.frame)) return false;
  try {
    const scope = getRendererWorkspaceScope(current.wc);
    return !current.wc.isDestroyed() && current.wc.mainFrame === current.frame && !!current.entryUrl && current.wc.getURL() === current.entryUrl &&
      current.frame.url === current.entryUrl && !!scope && sameProjectScope(scope, current.scope);
  } catch { return false; }
}
