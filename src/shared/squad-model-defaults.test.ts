import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateModelId, RETIRED_MODEL_MIGRATIONS } from './model-defaults';
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
    // Decisão do operador (docs/models/estudo-2026-09.md): 3.1 Pro sai da
    // lista oferecida do agy — mesmo `agy models` ainda aceitando o id.
    expect(migrateModelId('gemini-3.1-pro-high')).toBe('gemini-3.8-flash-high');
    expect(migrateModelId('gemini-3.1-pro-low')).toBe('gemini-3.8-flash-low');
    expect(migrateModelId('gpt-5.5')).toBe('gpt-5.6-luna');
    expect(migrateModelId('gpt-5.4-pro')).toBe('gpt-5.6-sol');
    expect(migrateModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(migrateModelId('muse')).toBe('muse-spark-1.3');
    expect(migrateModelId(undefined)).toBeUndefined();
  });

  it('migra grok aposentado (4.1/4/4-fast/code-fast-1/3) para o grok-4.7 vigente (confirmado via `grok models` instalado, 2026-09-27)', () => {
    expect(migrateModelId('grok-4.1')).toBe('grok-4.7');
    expect(migrateModelId('grok-4')).toBe('grok-4.7');
    expect(migrateModelId('grok-4-fast')).toBe('grok-4.7');
    expect(migrateModelId('grok-code-fast-1')).toBe('grok-4.7');
    expect(migrateModelId('grok-3')).toBe('grok-4.7');
  });

  it('migra agy 3.5 e OpenCode free que saíram das CLIs instaladas (2026-09-27)', () => {
    expect(migrateModelId('gemini-3.5-flash-low')).toBe('gemini-3.8-flash-low');
    expect(migrateModelId('gemini-3.5-flash-medium')).toBe('gemini-3.8-flash-medium');
    expect(migrateModelId('gemini-3.5-flash-high')).toBe('gemini-3.8-flash-high');
    expect(migrateModelId('opencode/deepseek-v4-flash-free')).toBe('opencode/big-pickle');
    expect(migrateModelId('opencode/north-mini-code-free')).toBe('opencode/big-pickle');
    // A Gemini API (voz/STT) usa o id sem sufixo de esforço: fica intacto.
    expect(migrateModelId('gemini-3.5-flash')).toBe('gemini-3.5-flash');
    // Copilot/OpenCode ainda servem gpt-5.2 e o Aider usa o3/gpt-4o: sem chave global.
    expect(migrateModelId('gpt-5.2')).toBe('gpt-5.2');
    expect(migrateModelId('o3')).toBe('o3');
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

describe('RETIRED_MODEL_MIGRATIONS × catálogos builtin', () => {
  it('nenhum id que o adapter ainda oferece é migrado para outro modelo em silêncio', () => {
    const dir = path.join(__dirname, '../adapters/builtin');
    const conflicts: string[] = [];
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const adapter = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
        models?: { list?: string[]; default?: string };
      };
      for (const model of [...(adapter.models?.list ?? []), adapter.models?.default]) {
        if (model && RETIRED_MODEL_MIGRATIONS[model]) conflicts.push(`${file}: ${model}`);
      }
    }
    expect(conflicts).toEqual([]);
  });
});
