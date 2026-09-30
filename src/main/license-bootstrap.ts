import { getAccessState, onAccessChanged } from './license-access';
import { BILLING_CHANNELS } from '../shared/billing-types';

/** Install notification before evaluating the cached-only, fail-closed authority.
 * Main calls this before cron/orchestration; cold unlock remains deferred by license-sync.
 */
export function initializeLicenseAuthority(broadcast: () => void = () => {
  const { BrowserWindow } = require('electron') as typeof import('electron');
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(BILLING_CHANNELS.changed);
}): () => void {
  const unsubscribe = onAccessChanged(() => broadcast());
  getAccessState();
  return unsubscribe;
}
