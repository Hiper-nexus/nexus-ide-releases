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
    expect(applySquadModelDefault({ cli: 'codex' }).model).toBe('gpt-5.6-sol');
    expect(applySquadModelDefault({ cli: 'grok' }).model).toBe('grok-4.6');
    expect(applySquadModelDefault({ cli: 'agy' }).model).toBe('gemini-3.8-pro-high');
    expect(applySquadModelDefault({ cli: 'grok', model: 'grok-4.1' }).model).toBe(
      'grok-4.1',
    );
  });

  it('migrates retired/legacy model ids to the active lineage at spawn time', () => {
    // gemini-3.1-pro-high: depreciação de produto (2026-09-14) — todo pane/squad
    // agy sempre no modelo mais recente da linhagem pro.
    expect(migrateModelId('gemini-3.1-pro-high')).toBe('gemini-3.8-pro-high');
    expect(migrateModelId('gpt-5.4-pro')).toBe('gpt-5.6-sol');
    expect(migrateModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(migrateModelId(undefined)).toBeUndefined();
  });
});
