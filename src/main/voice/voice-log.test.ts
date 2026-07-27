import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatVoiceLine,
  logVoice,
} from './voice-log';

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
});
