import { describe, expect, it } from 'vitest';
import { agyModelForEffort, withoutEffortArg } from './agy-effort-model';

const LIST = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
];

describe('AGY: esforço no sufixo do modelo (F-705)', () => {
  it('o esforço pedido escolhe a variante do mesmo modelo (a combinação que o AGY aceita)', () => {
    // Pane real de 30/09: "gemini-3.8-flash-low" + --effort medium → code 1.
    expect(agyModelForEffort('gemini-3.8-flash-low', 'medium', LIST)).toEqual({
      model: 'gemini-3.8-flash-medium',
      dropEffort: false,
    });
    expect(agyModelForEffort('gemini-3.8-flash-high', 'medium', LIST).model).toBe('gemini-3.8-flash-medium');
    expect(agyModelForEffort('gemini-3.8-flash-high', 'high', LIST)).toEqual({
      model: 'gemini-3.8-flash-high',
      dropEffort: false,
    });
  });

  it('sem a variante, o modelo manda e o --effort sai', () => {
    expect(agyModelForEffort('gemini-3.1-pro-high', 'medium', LIST)).toEqual({
      model: 'gemini-3.1-pro-high',
      dropEffort: true,
    });
  });

  it('modelo sem sufixo de esforço ou sem esforço pedido fica como está', () => {
    expect(agyModelForEffort('claude-sonnet-4-6', 'high', LIST)).toEqual({
      model: 'claude-sonnet-4-6',
      dropEffort: false,
    });
    expect(agyModelForEffort('gemini-3.8-flash-low', undefined, LIST).model).toBe('gemini-3.8-flash-low');
  });

  it('Gemini sem sufixo: usa a variante do esforço ou tira o --effort (o AGY recusa o par)', () => {
    // F-773, 03/10: `--model gemini-4-argon --effort high` → "--effort is not
    // supported for model" e o pane morreu em 4 s, antes do primeiro turno.
    expect(agyModelForEffort('gemini-4-argon', 'high', LIST)).toEqual({
      model: 'gemini-4-argon',
      dropEffort: true,
    });
    expect(agyModelForEffort('gemini-3.8-flash', 'high', LIST)).toEqual({
      model: 'gemini-3.8-flash-high',
      dropEffort: false,
    });
    expect(agyModelForEffort('gemini-4-argon', undefined, LIST)).toEqual({
      model: 'gemini-4-argon',
      dropEffort: false,
    });
  });

  it('tira o par --effort do argv, nas duas grafias', () => {
    expect(withoutEffortArg(['--effort', 'medium', '--x'], '--effort')).toEqual(['--x']);
    expect(withoutEffortArg(['--effort=medium', '--x'], '--effort')).toEqual(['--x']);
    expect(withoutEffortArg(['--x'], '--effort')).toEqual(['--x']);
  });
});
