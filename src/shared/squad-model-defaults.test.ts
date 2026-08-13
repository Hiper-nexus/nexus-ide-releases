import { describe, expect, it } from 'vitest';
import {
  applySquadModelDefault,
  defaultSquadModelForAdapter,
  SQUAD_MODEL_DEFAULTS,
} from './squad-model-defaults';

describe('squad model defaults', () => {
  it('maps providers to their strong defaults', () => {
    expect(defaultSquadModelForAdapter('codex')).toBe(SQUAD_MODEL_DEFAULTS.codex);
    expect(defaultSquadModelForAdapter('grok')).toBe(SQUAD_MODEL_DEFAULTS.grok);
    expect(defaultSquadModelForAdapter('agy')).toBe(SQUAD_MODEL_DEFAULTS.gemini);
  });

  it('fills only an empty model and preserves a manual choice', () => {
    expect(applySquadModelDefault({ cli: 'codex' }).model).toBe('gpt-5.6-terra');
    expect(applySquadModelDefault({ cli: 'grok' }).model).toBe('grok-4.5');
    expect(applySquadModelDefault({ cli: 'agy' }).model).toBe('gemini-3.7-flash-high');
    expect(applySquadModelDefault({ cli: 'grok', model: 'grok-4.1' }).model).toBe(
      'grok-4.1',
    );
  });
});
