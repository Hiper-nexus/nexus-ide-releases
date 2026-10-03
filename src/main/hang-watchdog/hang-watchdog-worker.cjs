'use strict';
/**
 * Worker do watchdog da main thread (campanha 0.50 C7; F-764 A.1).
 *
 * JS puro de propósito, como o `pcm-processor.js` do renderer: este arquivo
 * entra VERBATIM no bundle do main (`import … from './hang-watchdog-worker.cjs?raw'`)
 * e roda numa worker com `eval: true` — sem asar no caminho, sem bundler
 * reescrevendo o código. Os testes carregam o MESMO arquivo como módulo (as
 * funções puras abaixo) e sobem um Worker real com o MESMO texto contra uma
 * main thread presa num laço.
 *
 * O que a worker faz:
 *  - mede o gap do heartbeat do main; acima do limiar abre um EPISÓDIO de
 *    travamento e grava `main-hang-marker.json` + uma linha em
 *    `main-hang.ndjson`, com o último resumo de event-loop que o main mandou;
 *  - UMA vez por episódio liga o Profiler da main thread pelo inspector
 *    (`Session.connectToMainThread()`). As mensagens do inspector chegam à
 *    main por INTERRUPÇÃO do V8: funcionam com o JS preso num laço, inclusive
 *    dentro de uma regex longa (provado no Electron 43.7.4 com o fuse de
 *    inspect desligado — ver HANDOFF do F-764). O profile de ~3 s vira
 *    `logs/main-hang-<ts>.cpuprofile` e as frames mais quentes entram no
 *    ndjson;
 *  - quando o heartbeat volta, fecha o episódio com a duração medida.
 *
 * Tudo best-effort: inspector indisponível (build sem inspector, fuse, main
 * presa em código nativo que não atende interrupção) vira `profilerUnavailable`
 * com o motivo e o watchdog segue. Nada aqui derruba o app; nada de auto-kill.
 */

const PROFILE_FILE_RE = /^main-hang-.+\.cpuprofile$/;
/** Nós sintéticos que não dizem onde a CPU estava. */
const IGNORED_FRAMES = new Set(['(root)', '(idle)']);
const HISTORY_FILE = 'main-hang.ndjson';
const MARKER_FILE = 'main-hang-marker.json';

function round1(value) {
  return Math.round(value * 10) / 10;
}

function errorText(error) {
  const text = error && typeof error.message === 'string' ? error.message : String(error);
  return text.slice(0, 300);
}

/** `nome arquivo.js:linha:coluna` (1-based) para a pilha resumida. */
function frameLabel(callFrame) {
  const frame = callFrame || {};
  const name = frame.functionName || '(anonymous)';
  const url = typeof frame.url === 'string' ? frame.url : '';
  if (!url) return name;
  const file = url.slice(url.lastIndexOf('/') + 1);
  return name + ' ' + file + ':' + ((frame.lineNumber | 0) + 1) + ':' + ((frame.columnNumber | 0) + 1);
}

/** Amostras PRÓPRIAS por nó: `samples` quando existe, senão `hitCount`. */
function selfSamplesByNode(profile, nodes) {
  const selfById = new Map();
  const samples = profile && Array.isArray(profile.samples) ? profile.samples : null;
  if (samples && samples.length > 0) {
    for (const id of samples) selfById.set(id, (selfById.get(id) || 0) + 1);
    return selfById;
  }
  for (const node of nodes) {
    if (node.hitCount > 0) selfById.set(node.id, node.hitCount);
  }
  return selfById;
}

/** Pilha do nó (pais, do mais próximo ao mais distante), sem o `(root)`. */
function stackOf(nodeId, byId, parentOf, depth) {
  const stack = [];
  let parentId = parentOf.get(nodeId);
  while (parentId !== undefined && stack.length < depth) {
    const parent = byId.get(parentId);
    if (!parent || (parent.callFrame && parent.callFrame.functionName === '(root)')) break;
    stack.push(frameLabel(parent.callFrame));
    parentId = parentOf.get(parentId);
  }
  return stack;
}

/**
 * Frames mais quentes de um `.cpuprofile` por amostras PRÓPRIAS (self time):
 * onde a CPU estava de fato. Agrega por função (nome + url + linha + coluna)
 * porque a mesma função aparece em vários nós, um por caminho de chamada; a
 * pilha mostrada é a do nó mais pesado dela. Linha e coluna saem 1-based (o
 * V8 manda 0-based). Tempo dentro de uma regex conta para a função JS que a
 * chamou — é ela que aparece no topo.
 */
function summarizeCpuProfile(profile, options) {
  const limit = options && options.limit > 0 ? options.limit : 8;
  const stackDepth = options && options.stackDepth > 0 ? options.stackDepth : 6;
  const nodes = profile && Array.isArray(profile.nodes) ? profile.nodes.filter((node) => node && typeof node.id === 'number') : [];
  const byId = new Map();
  const parentOf = new Map();
  for (const node of nodes) {
    byId.set(node.id, node);
    for (const child of Array.isArray(node.children) ? node.children : []) parentOf.set(child, node.id);
  }
  let sampleCount = 0;
  const frames = new Map();
  for (const [id, count] of selfSamplesByNode(profile, nodes)) {
    sampleCount += count;
    const node = byId.get(id);
    const callFrame = (node && node.callFrame) || {};
    const functionName = callFrame.functionName || '(anonymous)';
    if (!node || IGNORED_FRAMES.has(functionName)) continue;
    const url = typeof callFrame.url === 'string' ? callFrame.url : '';
    const line = (callFrame.lineNumber | 0) + 1;
    const column = (callFrame.columnNumber | 0) + 1;
    const key = functionName + '\n' + url + '\n' + line + '\n' + column;
    let frame = frames.get(key);
    if (!frame) {
      frame = { functionName, url, line, column, selfSamples: 0, heaviestId: id, heaviestSamples: 0 };
      frames.set(key, frame);
    }
    frame.selfSamples += count;
    if (count > frame.heaviestSamples) {
      frame.heaviestSamples = count;
      frame.heaviestId = id;
    }
  }
  const topFrames = Array.from(frames.values())
    .sort((a, b) => b.selfSamples - a.selfSamples)
    .slice(0, limit)
    .map((frame) => ({
      functionName: frame.functionName,
      url: frame.url,
      line: frame.line,
      column: frame.column,
      selfSamples: frame.selfSamples,
      selfPercent: sampleCount > 0 ? round1((frame.selfSamples / sampleCount) * 100) : 0,
      stack: stackOf(frame.heaviestId, byId, parentOf, stackDepth),
    }));
  const hasClock = profile && typeof profile.startTime === 'number' && typeof profile.endTime === 'number';
  // startTime/endTime do V8 são em microssegundos.
  const durationMs = hasClock ? Math.round((profile.endTime - profile.startTime) / 1000) : null;
  return { sampleCount, durationMs, topFrames };
}

/** Nome ordenável por data: `main-hang-2026-10-03T11-41-37-123Z.cpuprofile`. */
function profileFileName(at) {
  return 'main-hang-' + new Date(at).toISOString().replace(/[:.]/g, '-') + '.cpuprofile';
}

/**
 * Quais `.cpuprofile` apagar: mantém os `keep` mais recentes enquanto o total
 * couber em `maxTotalBytes` (o mais recente fica sempre — ele já passou pelo
 * teto por arquivo na gravação). Arquivos de fora do padrão nunca entram.
 */
function planProfileRetention(entries, policy) {
  const keep = policy && policy.keep > 0 ? policy.keep : 5;
  const maxTotalBytes = policy && policy.maxTotalBytes > 0 ? policy.maxTotalBytes : Number.POSITIVE_INFINITY;
  const profiles = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.name === 'string' && PROFILE_FILE_RE.test(entry.name))
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const remove = [];
  let kept = 0;
  let totalBytes = 0;
  for (const entry of profiles) {
    const size = entry.size > 0 ? entry.size : 0;
    if (kept < keep && (kept === 0 || totalBytes + size <= maxTotalBytes)) {
      kept += 1;
      totalBytes += size;
    } else {
      remove.push(entry.name);
    }
  }
  return remove;
}

/**
 * Máquina de estados do watchdog, com tudo que toca o mundo injetado (relógio,
 * fs, inspector, timers, canal com o main) — a worker real e os testes usam o
 * mesmo código.
 */
function createHangWatchdog(deps) {
  const config = deps.config;
  let lastHeartbeatAt = null;
  let lastCheckAt = null;
  let eventLoop = null;
  let runtimeContext = null;
  let episode = null;
  let captureInFlight = false;

  function logsPath(name) {
    return deps.joinPath(config.logsDir, name);
  }

  /** Linha no histórico (com rotação), opcionalmente no marker, e aviso ao main. */
  function writeRecord(record, writeMarker) {
    const line = JSON.stringify(record) + '\n';
    try {
      deps.fs.mkdirSync(config.logsDir, { recursive: true });
    } catch {}
    if (writeMarker) {
      try {
        deps.fs.writeFileSync(logsPath(MARKER_FILE), line);
      } catch {}
    }
    // F-764: o marker é sobrescrito; o histórico guarda TODOS os travamentos
    // (o incidente de 03/10 teve três seguidos e só o último sobrou).
    try {
      const history = logsPath(HISTORY_FILE);
      try {
        if (deps.fs.statSync(history).size > config.historyRotateBytes) deps.fs.renameSync(history, history + '.1');
      } catch {}
      deps.fs.appendFileSync(history, line);
    } catch {}
    // O main lê isto quando voltar a respirar (vira linha no main.trace.ndjson).
    try {
      deps.notify({ type: 'hang-record', record });
    } catch {}
  }

  function pruneProfiles() {
    try {
      const entries = [];
      for (const name of deps.fs.readdirSync(config.logsDir)) {
        if (!PROFILE_FILE_RE.test(name)) continue;
        let size = 0;
        try {
          size = deps.fs.statSync(logsPath(name)).size;
        } catch {}
        entries.push({ name, size });
      }
      const plan = planProfileRetention(entries, { keep: config.maxProfiles, maxTotalBytes: config.maxProfilesTotalBytes });
      for (const name of plan) {
        try {
          deps.fs.unlinkSync(logsPath(name));
        } catch {}
      }
    } catch {}
  }

  /** Grava o `.cpuprofile` (com teto de tamanho) e anota o resultado em `fields`. */
  function saveProfile(profile, fields) {
    let json;
    try {
      json = JSON.stringify(profile);
    } catch (error) {
      fields.profileFile = null;
      fields.profileError = errorText(error);
      return;
    }
    fields.profileBytes = Buffer.byteLength(json);
    if (fields.profileBytes > config.maxProfileBytes) {
      fields.profileFile = null;
      fields.profileSkipped = 'acima de ' + config.maxProfileBytes + ' bytes';
      return;
    }
    const name = profileFileName(deps.now());
    try {
      deps.fs.mkdirSync(config.logsDir, { recursive: true });
      deps.fs.writeFileSync(logsPath(name), json);
      fields.profileFile = name;
    } catch (error) {
      fields.profileFile = null;
      fields.profileError = errorText(error);
      return;
    }
    pruneProfiles();
  }

  /**
   * Uma captura: enable → intervalo de amostragem → start → espera → stop.
   * Se a main não atender o inspector a tempo (presa em código nativo, que
   * não passa pelo ponto de interrupção do V8), desiste com o motivo — os
   * comandos que ficaram na fila morrem com a sessão desconectada.
   */
  function capture(episodeHeartbeatAt) {
    captureInFlight = true;
    const startedAt = deps.now();
    const timeoutMs = config.profileDurationMs + config.inspectorTimeoutMs;
    let session = null;
    let finished = false;
    let deadline = null;
    let stopTimer = null;

    function finish(fields) {
      if (finished) return;
      finished = true;
      captureInFlight = false;
      if (deadline !== null) deps.clearTimeout(deadline);
      if (stopTimer !== null) deps.clearTimeout(stopTimer);
      if (session) {
        try {
          session.disconnect();
        } catch {}
      }
      const capturedAt = deps.now();
      writeRecord(
        Object.assign(
          {
            kind: 'main-thread-hang-profile',
            appVersion: config.version,
            lastHeartbeatAt: episodeHeartbeatAt,
            capturedAt,
            captureMs: capturedAt - startedAt,
          },
          fields,
        ),
        false,
      );
    }

    try {
      session = deps.openInspectorSession();
    } catch (error) {
      finish({ profilerUnavailable: errorText(error) });
      return;
    }

    function post(method, params) {
      return new Promise((resolve, reject) => {
        try {
          session.post(method, params || {}, (error, result) => (error ? reject(error) : resolve(result)));
        } catch (error) {
          reject(error);
        }
      });
    }

    deadline = deps.setTimeout(() => {
      finish({
        profilerUnavailable:
          'a main thread não atendeu o inspector em ' +
          Math.round(timeoutMs / 1000) +
          ' s (presa fora do JS: código nativo ou syscall?)',
      });
    }, timeoutMs);

    post('Profiler.enable')
      .then(() => post('Profiler.setSamplingInterval', { interval: config.samplingIntervalUs }))
      .then(() => post('Profiler.start'))
      .then(
        () =>
          new Promise((resolve) => {
            stopTimer = deps.setTimeout(resolve, config.profileDurationMs);
          }),
      )
      .then(() => post('Profiler.stop'))
      .then((result) => {
        if (finished) return;
        const profile = result && result.profile;
        if (!profile) {
          finish({ profilerUnavailable: 'Profiler.stop voltou sem profile' });
          return;
        }
        const summary = summarizeCpuProfile(profile, { limit: config.topFrames, stackDepth: config.stackDepth });
        const fields = {
          sampleCount: summary.sampleCount,
          profileDurationMs: summary.durationMs,
          topFrames: summary.topFrames,
        };
        saveProfile(profile, fields);
        finish(fields);
      })
      .catch((error) => finish({ profilerUnavailable: errorText(error) }));
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'heartbeat' && typeof message.at === 'number') {
      if (episode && message.at > episode.lastHeartbeatAt) {
        writeRecord(
          {
            kind: 'main-thread-hang-recovered',
            appVersion: config.version,
            lastHeartbeatAt: episode.lastHeartbeatAt,
            recoveredAt: message.at,
            hangDurationMs: message.at - episode.lastHeartbeatAt,
          },
          false,
        );
        episode = null;
      }
      lastHeartbeatAt = message.at;
      return;
    }
    if (message.type === 'event-loop' && message.summary && typeof message.summary === 'object') {
      eventLoop = message.summary;
    }
    if (message.type === 'runtime-context' && message.context && typeof message.context === 'object') {
      try { if (JSON.stringify(message.context).length <= 65_536) runtimeContext = message.context; }
      catch { /* Ignore malformed diagnostics. */ }
    }
  }

  function check() {
    const now = deps.now();
    const previousCheckAt = lastCheckAt;
    lastCheckAt = now;
    if (lastHeartbeatAt === null) return;
    // A própria worker ficou parada (Mac dormindo, processo suspenso): o gap
    // medido não é culpa da main. Sem episódio aberto, recomeça a contagem —
    // se a main estiver mesmo presa, o gap volta a crescer e é pego.
    if (previousCheckAt !== null && now - previousCheckAt > config.thresholdMs && !episode) {
      lastHeartbeatAt = now;
      return;
    }
    const gap = now - lastHeartbeatAt;
    if (gap <= config.thresholdMs) return;
    if (!episode) episode = { lastHeartbeatAt, markedAt: null, captureRequested: false };
    // Remarca no máximo a cada `remarkEveryMs`: a duração atualiza sem spam.
    if (episode.markedAt === null || now - episode.markedAt >= config.remarkEveryMs) {
      episode.markedAt = now;
      writeRecord(
        {
          kind: 'main-thread-hang',
          hangDurationMs: gap,
          appVersion: config.version,
          lastHeartbeatAt,
          detectedAt: now,
          eventLoop,
          runtimeContext,
        },
        true,
      );
    }
    // Uma captura por episódio, nunca duas ao mesmo tempo.
    if (!episode.captureRequested && !captureInFlight && config.profileDurationMs > 0) {
      episode.captureRequested = true;
      capture(episode.lastHeartbeatAt);
    }
  }

  return { handleMessage, check };
}

/** Inspector da main thread visto da worker; lança quando não há inspector. */
function openMainThreadInspectorSession() {
  const inspector = require('node:inspector');
  const session = new inspector.Session();
  session.connectToMainThread();
  return session;
}

function runInWorker(workerThreads) {
  const fs = require('node:fs');
  const path = require('node:path');
  const parentPort = workerThreads.parentPort;
  const watchdog = createHangWatchdog({
    config: workerThreads.workerData.config,
    now: () => Date.now(),
    fs,
    joinPath: (dir, name) => path.join(dir, name),
    openInspectorSession: openMainThreadInspectorSession,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    notify: (message) => parentPort.postMessage(message),
  });
  parentPort.on('message', (message) => {
    if (message && message.type === 'stop') process.exit(0);
    watchdog.handleMessage(message);
  });
  setInterval(() => watchdog.check(), workerThreads.workerData.config.checkIntervalMs);
}

module.exports = {
  createHangWatchdog,
  planProfileRetention,
  profileFileName,
  summarizeCpuProfile,
};

const workerThreads = require('node:worker_threads');
if (
  !workerThreads.isMainThread &&
  workerThreads.workerData &&
  workerThreads.workerData.kind === 'nexus-main-hang-watchdog'
) {
  runInWorker(workerThreads);
}
