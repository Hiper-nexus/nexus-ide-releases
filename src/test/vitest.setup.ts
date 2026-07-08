import os from 'node:os';
import path from 'node:path';

const baseDir = path.join(os.tmpdir(), `nexus-ide-vitest-${process.pid}`);

process.env.NEXUS_VOICE_LOG_FILE ??= path.join(baseDir, 'voice.log');
process.env.NEXUS_VOICE_LOG_MAX_BYTES ??= '1048576';
process.env.NEXUS_JARVIS_METRICS_FILE ??= path.join(baseDir, 'jarvis-metrics.log');
