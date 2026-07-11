import type { AecRuntimeStatus } from './aec-runtime';
import { AecHelperClient, type AecHelperMetrics } from './aec-helper-client';
import { AecLiveProcessor, type LiveAecProcessor } from './aec-live-processor';
import { spawnAecHelper } from './aec-process-transport';
import { logVoice } from './voice-log';
import { WasmAecProcessor } from './aec-wasm-processor';

export interface NativeAecRuntime {
  processor?: LiveAecProcessor;
  stop(): void;
}

export function startNativeAecRuntime(status: AecRuntimeStatus): NativeAecRuntime {
  if (status.backend === 'wasm-aec3') {
    const processor = new WasmAecProcessor(
      () => logVoice('info', 'voice.aecReady', 'AEC3 WebAssembly pronto', {
        backend: status.backend,
      }),
      (error) => logVoice('warn', 'voice.aecDegraded', 'AEC3 WebAssembly falhou; Chromium segue ativo', {
        backend: status.backend,
        error: error.message.slice(0, 300),
      }),
    );
    return { processor, stop: () => processor.dispose() };
  }
  if (!status.native || !status.helperPath) return { stop() {} };
  try {
    const transport = spawnAecHelper(status.helperPath);
    const client = new AecHelperClient({ runtime: status, transport });
    const processor = new AecLiveProcessor(client);
    client.on('ready', () => {
      logVoice('info', 'voice.aecReady', 'AEC nativo confirmou handshake', {
        backend: status.backend,
      });
    });
    client.on('metrics', (metrics: AecHelperMetrics) => {
      logVoice('info', 'voice.aecMetrics', 'métricas do cancelador de eco', {
        backend: status.backend,
        ...metrics,
      });
    });
    client.on('error', (error: Error) => {
      processor.reset();
      logVoice('warn', 'voice.aecDegraded', 'AEC nativo falhou; Chromium segue ativo', {
        backend: status.backend,
        error: error.message.slice(0, 300),
      });
    });
    client.start();
    return { processor, stop: () => client.stop() };
  } catch (error) {
    logVoice('warn', 'voice.aecSpawnFailed', 'helper AEC não iniciou; Chromium segue ativo', {
      backend: status.backend,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    return { stop() {} };
  }
}
