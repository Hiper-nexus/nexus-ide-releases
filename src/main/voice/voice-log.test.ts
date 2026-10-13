import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatVoiceLine,
  logVoice,
  sanitizeRendererVoiceEvent,
} from './voice-log';
import { LiveToolCallCoordinator } from './live-tool-call-registry';
import { JarvisLiveSession } from './jarvis-live';

/**
 * Logger persistente de voz: garante que a morte silenciosa do mic (e demais
 * eventos do pipeline) deixem evidência em disco — hoje tudo vai só pro
 * console do renderer, ilegível no app empacotado.
 */
describe('voice-log formatVoiceLine', () => {
  it('inclui tag de nível, evento e mensagem', () => {
    const line = formatVoiceLine({
      ts: '2026-07-07T12:00:00.000Z',
      level: 'warn',
      event: 'mic.died',
      msg: 'track ended',
    });
    expect(line).toContain('[WARN]');
    expect(line).toContain('mic.died');
    expect(line).toContain(': track ended');
  });

  it('serializa data como JSON no fim da linha', () => {
    const line = formatVoiceLine({
      ts: '2026-07-07T12:00:00.000Z',
      level: 'info',
      event: 'wake.detected',
      msg: 'hey jarvis',
      data: { score: 0.97 },
    });
    expect(line.endsWith('{"score":0.97}')).toBe(true);
  });

  it('não acrescenta lixo quando msg e data ausentes', () => {
    const line = formatVoiceLine({
      ts: '2026-07-07T12:00:00.000Z',
      level: 'error',
      event: 'stt.fail',
    });
    expect(line.trim()).toBe('2026-07-07T12:00:00.000Z [ERROR] stt.fail');
  });
});

describe('voice-log logVoice (persistência)', () => {
  let tmpDir: string;
  let logFile: string;
  let previousLogFile: string | undefined;
  let previousLogMaxBytes: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-log-'));
    logFile = path.join(tmpDir, 'voice.log');
    previousLogFile = process.env.NEXUS_VOICE_LOG_FILE;
    previousLogMaxBytes = process.env.NEXUS_VOICE_LOG_MAX_BYTES;
    process.env.NEXUS_VOICE_LOG_FILE = logFile;
    // cap pequeno pra exercitar rotação sem escrever 1MB no teste.
    process.env.NEXUS_VOICE_LOG_MAX_BYTES = '2048';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousLogFile === undefined) {
      delete process.env.NEXUS_VOICE_LOG_FILE;
    } else {
      process.env.NEXUS_VOICE_LOG_FILE = previousLogFile;
    }
    if (previousLogMaxBytes === undefined) {
      delete process.env.NEXUS_VOICE_LOG_MAX_BYTES;
    } else {
      process.env.NEXUS_VOICE_LOG_MAX_BYTES = previousLogMaxBytes;
    }
  });

  it('cria o diretório e anexa a linha', () => {
    logVoice('warn', 'mic.died', 'track ended', { attempt: 3 });
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('[WARN]');
    expect(content).toContain('mic.died');
    expect(content).toContain('track ended');
    expect(content.trim()).toMatch(/\{"attempt":3\}$/);
  });

  it('nunca cria observabilidade dentro do workspace ativo', () => {
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace);

    logVoice('info', 'turn.committed', 'turno pronto', { turnId: 'turn-1' });

    const workspaceLog = path.join(workspace, '.nexus', 'logs', 'voice.log');
    expect(fs.existsSync(workspaceLog)).toBe(false);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('turn.committed');
  });

  it('rotaciona quando excede o limite (voice.log -> voice.log.1)', () => {
    // Escreve bem mais que o cap (2048 bytes) em linhas de ~100 bytes.
    for (let i = 0; i < 60; i += 1) {
      logVoice('info', 'wake.score', `passagem ${i} `.repeat(6).trim());
    }
    const rotated = path.join(tmpDir, 'voice.log.1');
    expect(fs.existsSync(rotated)).toBe(true);
    // Após rotacionar, voice.log volta a ser pequeno (poucas linhas novas).
    expect(fs.statSync(logFile).size).toBeLessThan(2048);
  });

  it('F-1424: defesa em profundidade e fluxo de log nunca gravam frase sintética no arquivo de log', () => {
    const syntheticPhrase = 'frase-sintetica-f1424';

    // 1. Evento com transcrição em msg: msg é redigida e vira chars em data
    const sanitizedMsg = sanitizeRendererVoiceEvent({
      level: 'info',
      event: 'stt.dictationTranscript',
      msg: syntheticPhrase,
      data: { latencyMs: 50 },
    });
    expect(sanitizedMsg.msg).toBeUndefined();
    expect(sanitizedMsg.data?.chars).toBe(syntheticPhrase.length);
    expect(JSON.stringify(sanitizedMsg)).not.toContain(syntheticPhrase);

    // 2. Evento com campos sensíveis em data: chaves text/transcript/raw são removidas
    const sanitizedData = sanitizeRendererVoiceEvent({
      level: 'info',
      event: 'stt.dictationRaw',
      msg: 'transcrição bruta concluída',
      data: {
        text: syntheticPhrase,
        raw: syntheticPhrase,
        final: syntheticPhrase,
        mode: 'code',
      },
    });
    expect(sanitizedData.msg).toBe('transcrição bruta concluída');
    expect(sanitizedData.data?.text).toBeUndefined();
    expect(sanitizedData.data?.raw).toBeUndefined();
    expect(sanitizedData.data?.final).toBeUndefined();
    expect(sanitizedData.data?.chars).toBe(syntheticPhrase.length);
    expect(JSON.stringify(sanitizedData)).not.toContain(syntheticPhrase);

    // 3. Linha formatada não contém a frase sintética
    const line = formatVoiceLine({
      ts: '2026-07-07T12:00:00.000Z',
      level: sanitizedMsg.level,
      event: sanitizedMsg.event,
      msg: sanitizedMsg.msg,
      data: sanitizedMsg.data,
    });
    expect(line).not.toContain(syntheticPhrase);

    // 4. Arquivo gravado em disco não contém a frase sintética
    logVoice(sanitizedMsg.level, sanitizedMsg.event, sanitizedMsg.msg, sanitizedMsg.data);
    logVoice(sanitizedData.level, sanitizedData.event, sanitizedData.msg, sanitizedData.data);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).not.toContain(syntheticPhrase);
  });
});

/**
 * F-1424 parte 2: a sanitização vive DENTRO do `logVoice` — o gargalo único
 * que formata, grava no voice.log e espelha no console. Os achados da revisão
 * eram exatamente chamadores que burlavam o sanitizador do IPC: summaries de
 * ação/tool (com URL ditada, títulos de pane/missão) em `msg` de
 * actionResult/realtimeActionResult e em `data.summary` de live.toolLateResult
 * gravados direto do Main. Aqui o marcador sintético entra pelo caminho que o
 * revisor reproduziu e não pode sobreviver nem no arquivo nem no console.
 */
describe('voice-log F-1424 parte 2 (sanitização no gargalo logVoice)', () => {
  const MARKER = 'https://example.invalid/frase-sintetica-f1424b';

  let tmpDir: string;
  let logFile: string;
  let previousLogFile: string | undefined;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  const readCapturedConsole = (): string =>
    consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map((arg) => String(arg)).join(' '))
      .join('\n');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-voice-log2-'));
    logFile = path.join(tmpDir, 'voice.log');
    previousLogFile = process.env.NEXUS_VOICE_LOG_FILE;
    process.env.NEXUS_VOICE_LOG_FILE = logFile;
    consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousLogFile === undefined) {
      delete process.env.NEXUS_VOICE_LOG_FILE;
    } else {
      process.env.NEXUS_VOICE_LOG_FILE = previousLogFile;
    }
  });

  it('jarvis.actionResult com summary (URL ditada) em msg não vaza para arquivo nem console', () => {
    logVoice('info', 'jarvis.actionResult', `browser aberto em ${MARKER}`, {
      tool: 'open_browser',
      ok: true,
    });
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('jarvis.actionResult');
    expect(content).not.toContain(MARKER);
    expect(readCapturedConsole()).not.toContain(MARKER);
  });

  it('jarvis.realtimeActionResult com summary em msg não vaza para arquivo nem console', () => {
    logVoice('warn', 'jarvis.realtimeActionResult', `abrir browser em ${MARKER}`, {
      tool: 'open_browser',
      ok: false,
      callId: 'call-1',
    });
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('jarvis.realtimeActionResult');
    expect(content).not.toContain(MARKER);
    expect(readCapturedConsole()).not.toContain(MARKER);
  });

  it('live.toolLateResult via LiveToolCallCoordinator real (call desconhecida) não grava o summary', () => {
    const session = new JarvisLiveSession(() => {}, () => 1_000);
    session.setEnabled(true);
    session.start({ reason: 'manual' });
    const coordinator = new LiveToolCallCoordinator({
      fsm: session,
      getProvider: () => null,
      onResultContext: vi.fn(),
    });

    // Call jamais "claimada": o coordinator cai no ramo tardio/desconhecido
    // e loga direto do Main — o caminho que o revisor apontou.
    expect(
      coordinator.complete({
        sessionId: session.getState().sessionId ?? 'sess-1',
        at: 1_001,
        source: 'realtime',
        callId: 'call-never-claimed',
        name: 'nexus_action',
        tool: 'open_browser',
        ok: true,
        summary: `browser aberto em ${MARKER}`,
        output: null,
      }),
    ).toBe(false);

    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('live.toolLateResult');
    expect(content).not.toContain(MARKER);
    expect(readCapturedConsole()).not.toContain(MARKER);
  });

  it('chaves sensíveis em data (summary/url/args/prompt/query/message/content) viram chars ou somem', () => {
    logVoice('warn', 'live.toolLateResult', 'resultado tardio/duplicado não reenviado', {
      callId: 'call-1',
      summary: `browser aberto em ${MARKER}`,
      url: MARKER,
      args: { url: MARKER, prompt: MARKER },
      prompt: MARKER,
      query: MARKER,
      message: MARKER,
      content: MARKER,
    });
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('"callId":"call-1"');
    expect(content).not.toContain(MARKER);
    expect(content).not.toContain('"summary"');
    expect(readCapturedConsole()).not.toContain(MARKER);
  });

  it('mensagens estáticas da allowlist seguem inteiras (log não degrada)', () => {
    logVoice('info', 'stt.dictationTranscript', 'ditado transcrito', {
      chars: 21,
      latencyMs: 50,
    });
    logVoice('warn', 'live.toolLateResult', 'resultado tardio/duplicado não reenviado', {
      callId: 'call-1',
    });
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain(': ditado transcrito');
    expect(content).toContain(': resultado tardio/duplicado não reenviado');
  });
});
