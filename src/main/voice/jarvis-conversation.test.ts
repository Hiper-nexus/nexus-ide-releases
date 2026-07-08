import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION_MAX_MESSAGES,
  JarvisConversation,
  RESUME_INJECT_MESSAGES,
  RESUME_WINDOW_MS,
} from './jarvis-conversation';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conv-'));
  file = path.join(dir, 'conversation.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function make(start = 1_000) {
  let now = start;
  const conv = new JarvisConversation(file, () => now);
  return { conv, advance: (ms: number) => (now += ms) };
}

describe('JarvisConversation', () => {
  it('grava pares e reinjeta os últimos turnos dentro da janela', () => {
    const { conv } = make();
    conv.record('abre o terminal', 'Terminal aberto, patrão.');
    conv.record('roda os testes', 'Rodando os testes.');
    const resumed = conv.resume();
    expect(resumed).toEqual([
      { role: 'user', content: 'abre o terminal' },
      { role: 'assistant', content: 'Terminal aberto, patrão.' },
      { role: 'user', content: 'roda os testes' },
      { role: 'assistant', content: 'Rodando os testes.' },
    ]);
  });

  it('sobrevive à morte da sessão: um novo objeto lê o disco', () => {
    const { conv } = make();
    conv.record('lembra que meu nome é Cléofas', 'Anotado, Cléofas.');
    // "Reinício": nova instância apontando pro mesmo arquivo.
    const revived = new JarvisConversation(file, () => 2_000);
    expect(revived.resume()).toEqual([
      { role: 'user', content: 'lembra que meu nome é Cléofas' },
      { role: 'assistant', content: 'Anotado, Cléofas.' },
    ]);
  });

  it('não reinjeta fora da janela de resume', () => {
    const { conv, advance } = make();
    conv.record('oi', 'Olá, patrão.');
    advance(RESUME_WINDOW_MS + 1);
    expect(conv.resume()).toEqual([]);
  });

  it('injeta no máximo RESUME_INJECT_MESSAGES', () => {
    const { conv } = make();
    for (let i = 0; i < 10; i += 1) conv.record(`pergunta ${i}`, `resposta ${i}`);
    expect(conv.resume()).toHaveLength(RESUME_INJECT_MESSAGES);
  });

  it('faz cap do histórico em CONVERSATION_MAX_MESSAGES', () => {
    const { conv } = make();
    for (let i = 0; i < CONVERSATION_MAX_MESSAGES; i += 1) {
      conv.record(`u${i}`, `a${i}`);
    }
    const revived = new JarvisConversation(file, () => 1_000);
    // resume só devolve os últimos poucos, mas o arquivo em disco respeita o cap.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as { turns: unknown[] };
    expect(onDisk.turns.length).toBe(CONVERSATION_MAX_MESSAGES);
    expect(revived.resume().length).toBe(RESUME_INJECT_MESSAGES);
  });

  it('ignora turnos com lado vazio', () => {
    const { conv } = make();
    conv.record('', 'resposta sem pergunta');
    conv.record('pergunta sem resposta', '   ');
    expect(conv.resume()).toEqual([]);
  });

  it('clear zera a conversa persistida', () => {
    const { conv } = make();
    conv.record('algo', 'ok');
    conv.clear();
    expect(conv.resume()).toEqual([]);
  });
});
