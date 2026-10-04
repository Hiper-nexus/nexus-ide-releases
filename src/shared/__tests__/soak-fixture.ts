import type { SoakSample } from '../soak-smoke';
export const soakFixtureNonce = '11111111-1111-4111-8111-111111111111';
export function soakSamples(): SoakSample[] {
  return Array.from({ length: 61 }, (_, index) => ({ sequence: index, elapsedMs: index * 5000 + 500,
    rendererPid: 1234, livePtys: 1, rendererHosts: 1,
    memoryBytes: { mainHeap: 32e6, mainRss: 160e6, rendererHeap: 48e6, rendererRss: 180e6, electronRss: 500e6, paneRss: 12e6 },
    activity: { writeConfirmed: true, executedMarker: true, renderedMarker: true, frames: 2, scroll: true, resize: true, workspaceRead: true, search: true, physicalClose: true } }));
}
export const soakCycle = () => ({ nonce: soakFixtureNonce, sequence: 0, sessionId: 'pty-fixture', paneId: 'pane-fixture',
  rendererPid: 1234, electronVersion: '43.7.4', heapUsedKiB: 32000,
  rendererHosts: 1, activity: { writeConfirmed: true, executedMarker: true, renderedMarker: true, frames: 2, scroll: true, resize: true, workspaceRead: true, search: true } });
