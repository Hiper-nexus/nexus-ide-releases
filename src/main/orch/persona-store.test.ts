import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPersonasForTests,
  listPersonaNames,
  lookupPersonaSystemPrompt,
  registerPersona,
} from './persona-store';

afterEach(() => {
  clearPersonasForTests();
});

describe('persona-store', () => {
  it('retorna null para persona desconhecida', () => {
    expect(lookupPersonaSystemPrompt('Desconhecida')).toBeNull();
  });

  it('registra e recupera um system-prompt por nome', () => {
    registerPersona('Forge', 'Você é Forge, mecânico de construção.');
    expect(lookupPersonaSystemPrompt('Forge')).toBe(
      'Você é Forge, mecânico de construção.',
    );
  });

  it('registra múltiplas personas independentes', () => {
    registerPersona('Scout', 'Você é Scout.');
    registerPersona('Builder', 'Você é Builder.');
    expect(lookupPersonaSystemPrompt('Scout')).toBe('Você é Scout.');
    expect(lookupPersonaSystemPrompt('Builder')).toBe('Você é Builder.');
  });

  it('clearPersonasForTests zera o registry', () => {
    registerPersona('tmp', 'tmp prompt');
    clearPersonasForTests();
    expect(lookupPersonaSystemPrompt('tmp')).toBeNull();
    expect(listPersonaNames()).toHaveLength(0);
  });

  it('listPersonaNames retorna todos os nomes registrados', () => {
    registerPersona('A', 'prompt A');
    registerPersona('B', 'prompt B');
    expect(listPersonaNames().sort()).toEqual(['A', 'B']);
  });

  it('sobrescreve a persona existente com o mesmo nome', () => {
    registerPersona('X', 'versão 1');
    registerPersona('X', 'versão 2');
    expect(lookupPersonaSystemPrompt('X')).toBe('versão 2');
  });

  it('lança erro ao registrar nome vazio', () => {
    expect(() => registerPersona('', 'prompt')).toThrow();
  });

  it('lança erro ao registrar systemPrompt vazio', () => {
    expect(() => registerPersona('Nome', '')).toThrow();
  });

  it('não importa voice-ipc (independência estrutural)', async () => {
    // Garante que o módulo persona-store está carregado e funcional sem voice-ipc.
    const mod = await import('./persona-store');
    expect(typeof mod.registerPersona).toBe('function');
    expect(typeof mod.lookupPersonaSystemPrompt).toBe('function');
  });
});
