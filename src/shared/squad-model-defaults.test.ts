import { describe, expect, it } from 'vitest';
import { migrateModelId } from './model-defaults';
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
    expect(defaultSquadModelForAdapter('gemini-cli')).toBeUndefined();
    expect(defaultSquadModelForAdapter('antigravity-cli')).toBe(
      SQUAD_MODEL_DEFAULTS.gemini,
    );
  });

  it('fills only an empty model and preserves a manual choice', () => {
    expect(applySquadModelDefault({ cli: 'codex' }).model).toBe('gpt-6-sol');
    expect(applySquadModelDefault({ cli: 'grok' }).model).toBe('grok-4.7');
    expect(applySquadModelDefault({ cli: 'agy' }).model).toBe('gemini-3.8-flash-high');
    expect(applySquadModelDefault({ cli: 'grok', model: 'grok-4.1' }).model).toBe(
      'grok-4.1',
    );
  });

  it('migrates retired/legacy model ids to the active lineage at spawn time', () => {
    expect(migrateModelId('gemini-3.1-pro-high')).toBe('gemini-3.8-flash-high');
    expect(migrateModelId('gpt-5.5')).toBe('gpt-5.6-luna');
    expect(migrateModelId('gpt-5.4-pro')).toBe('gpt-5.6-sol');
    expect(migrateModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(migrateModelId('muse')).toBe('muse-spark-1.3');
    expect(migrateModelId(undefined)).toBeUndefined();
  });

  it('não migra superseded que ainda roda (claude-opus-5) nem solta genérica (1.6)', () => {
    // Superseded ≠ retired: o 5.5 lidera a lista/routing, mas o 5 continua
    // executável em CLIs mais antigos — migrar descartaria o candidato.
    expect(migrateModelId('claude-opus-5')).toBe('claude-opus-5');
    expect(migrateModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    // Chave global solta reescreveria modelo de qualquer provider.
    expect(migrateModelId('1.6')).toBe('1.6');
    expect(migrateModelId('swe-2')).toBe('swe-2');
  });
});
