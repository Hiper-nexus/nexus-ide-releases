import { parentPort, workerData } from 'node:worker_threads';
import { compileManifest } from '../detect/compiler';
import { loadManifestDir } from '../detect/manifest';
import { PtyAnalysisCore } from './pty-analysis-core';
import type { AnalysisInput } from './pty-analysis-protocol';
import { AnalysisJobProgress } from './pty-analysis-progress';
const port = parentPort;
if (!port) throw new Error('analysis worker requires parent port');
try {
  const progress = workerData.analysisProgress instanceof SharedArrayBuffer ? new AnalysisJobProgress(workerData.analysisProgress) : null;
  let current: AnalysisInput | null = null;
  let activityToken = 0;
  const manifests = loadManifestDir(workerData.manifestDir).filter(({ manifest }) => !workerData.quarantinedManifests?.includes(manifest.id)).map(({ manifest }) => compileManifest(manifest));
  const core = new PtyAnalysisCore(manifests, (result) => port.postMessage(result), {
    start: (sessionId, manifestId) => {
      progress?.startActivity(++activityToken);
      port.postMessage({ kind: 'work-start', workerEpoch: current?.workerEpoch ?? 0, job: current?.eventSeq ?? 0, sessionId, manifestId, watchdogToken: current?.watchdogToken, activityToken });
    },
    end: () => {
      progress?.completeActivity(activityToken);
      port.postMessage({ kind: 'work-end', watchdogToken: current?.watchdogToken, activityToken });
    },
  });
  port.on('message', (record: AnalysisInput) => {
    current = record;
    if (record.watchdogToken) progress?.start(record.watchdogToken);
    port.postMessage({ kind: 'work-start', workerEpoch: record.workerEpoch, job: record.eventSeq, sessionId: record.sessionId, watchdogToken: record.watchdogToken });
    core.process(record);
    if (record.watchdogToken) progress?.complete(record.watchdogToken);
    current = null;
  });
  port.on('close', () => core.close());
  port.postMessage({ kind: 'ready' });
} catch { port.postMessage({ kind: 'failed', reason: 'initialization-failed' }); }
