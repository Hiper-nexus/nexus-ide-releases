import { parentPort, workerData } from 'node:worker_threads';
import { compileManifest } from '../detect/compiler';
import { loadManifestDir } from '../detect/manifest';
import { PtyAnalysisCore } from './pty-analysis-core';
import type { AnalysisInput } from './pty-analysis-protocol';
const port = parentPort;
if (!port) throw new Error('analysis worker requires parent port');
try {
  const manifests = loadManifestDir(workerData.manifestDir).filter(({ manifest }) => !workerData.quarantinedManifests?.includes(manifest.id)).map(({ manifest }) => compileManifest(manifest));
  const core = new PtyAnalysisCore(manifests, (result) => port.postMessage(result), {
    start: (sessionId, manifestId) => port.postMessage({ kind: 'work-start', workerEpoch: 1, job: 0, sessionId, manifestId }),
    end: () => port.postMessage({ kind: 'work-end' }),
  });
  port.on('message', (record: AnalysisInput) => {
    port.postMessage({ kind: 'work-start', workerEpoch: record.workerEpoch, job: record.eventSeq, sessionId: record.sessionId });
    core.process(record);
  });
  port.on('close', () => core.close());
  port.postMessage({ kind: 'ready' });
} catch { port.postMessage({ kind: 'failed', reason: 'initialization-failed' }); }
