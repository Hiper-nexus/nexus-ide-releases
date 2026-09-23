import { describe, expect, it } from 'vitest';
import {
  applyHarnessChanges,
  factoryHarnessTable,
  formatHarnessReceipt,
  isSkillAllowedByHarness,
  parseHarnessTable,
  resolveHarnessType,
  serializeHarnessTable,
} from './harness-table';

describe('harness table CRUD', () => {
  it('starts from factory and applies a batch all-or-nothing', () => {
    const base = factoryHarnessTable();
    const ok = applyHarnessChanges(base, [
      { op: 'edit_type', typeId: 'B1', set: { cli: 'codex', model: 'gpt-6-astra' } },
      { op: 'create_type', categoryId: 'development', typeId: 'copy', name: 'Copy', set: { cli: 'claude', effort: 'high' } },
    ]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const b1 = ok.table.categories.flatMap((c) => c.types).find((t) => t.typeId === 'B1');
    expect(b1?.values.cli).toBe('codex');
    expect(ok.table.categories[0].types.some((t) => t.typeId === 'copy')).toBe(true);
  });

  it('refuses the whole batch on any problem and writes nothing', () => {
    const base = factoryHarnessTable();
    const outcome = applyHarnessChanges(base, [
      { op: 'edit_type', typeId: 'B1', set: { effort: 'medium' } },
      { op: 'edit_type', typeId: 'NOPE', set: { effort: 'high' } },
    ]);
    expect(outcome.ok).toBe(false);
    // base intacto
    expect(base.categories[0].types.find((t) => t.typeId === 'B1')?.values.cli).toBeUndefined();
  });

  it('rejects unknown effort with a fixable problem', () => {
    const outcome = applyHarnessChanges(factoryHarnessTable(), [
      { op: 'edit_type', typeId: 'B1', set: { effort: 'ultra' as 'high' } },
    ]);
    expect(outcome.ok).toBe(false);
  });

  it('restore_type brings factory values back', () => {
    let table = factoryHarnessTable();
    const edited = applyHarnessChanges(table, [
      { op: 'edit_type', typeId: 'B1', set: { cli: 'codex' } },
    ]);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    table = edited.table;
    const restored = applyHarnessChanges(table, [{ op: 'restore_type', typeId: 'B1' }]);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const b1 = restored.table.categories.flatMap((c) => c.types).find((t) => t.typeId === 'B1');
    expect(b1?.values.cli).toBeUndefined();
  });
});

describe('resolveHarnessType', () => {
  const table = factoryHarnessTable();

  it('resolves by id and by name', () => {
    expect(resolveHarnessType(table, 'B1').typeId).toBe('B1');
    expect(resolveHarnessType(table, 'fix de bug').typeId).toBe('B1');
  });

  it('unknown type falls back to the declared default — never refuses', () => {
    const resolution = resolveHarnessType(table, 'does-not-exist-xyz');
    expect(resolution.via).toBe('default');
    expect(resolution.typeId).toBe('default');
    expect(resolution.values.effort).toBe('medium');
  });

  it('survives a table whose default row was removed (no infinite recursion)', () => {
    const stripped = {
      version: 2,
      categories: [
        {
          categoryId: 'development',
          name: 'Dev',
          types: [{ typeId: 'B1', name: 'fix de bug', values: { effort: 'low' as const } }],
        },
      ],
    };
    const resolution = resolveHarnessType(stripped, 'nope');
    expect(resolution.via).toBe('default');
    expect(resolution.values.effort).toBe('medium');
  });
});

describe('receipt OVKA-748', () => {
  it('declares harness, filter and (optionally) decisor/origins', () => {
    const resolution = resolveHarnessType(factoryHarnessTable(), 'B1');
    const receipt = formatHarnessReceipt({
      resolution,
      explicit: { cli: 'claude', model: 'claude-sonnet-5', effort: 'high' },
      classificationVia: 'keyword',
      decisorNote: 'JEV sem chave — decidido pela regra (task-router).',
      originNotes: ['CLI=escopo da missão'],
    });
    expect(receipt).toContain('▸ harness:');
    expect(receipt).toContain('task=B1');
    expect(receipt).toContain('filtro=nenhum');
    expect(receipt).toContain('▸ decisor:');
    expect(receipt).toContain('▸ origens:');
    expect(receipt).toContain('claude-sonnet-5');
  });
});

describe('skill gate OVKA-713', () => {
  it('absence of filter frees', () => {
    expect(isSkillAllowedByHarness({}, 'anything').allowed).toBe(true);
    expect(isSkillAllowedByHarness({ skills: [] }, 'anything').filter).toBe('none');
  });

  it('declared filter is a hard allowlist', () => {
    expect(isSkillAllowedByHarness({ skills: ['qa-fix-protocol'] }, 'qa-fix-protocol').allowed).toBe(true);
    const denied = isSkillAllowedByHarness({ skills: ['qa-fix-protocol'] }, 'impeccable');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('fora do filtro');
  });
});

describe('parse/serialize (persistência no settings-store)', () => {
  it('round-trips a customized table', () => {
    const edited = applyHarnessChanges(factoryHarnessTable(), [
      { op: 'edit_type', typeId: 'B1', set: { cli: 'codex', model: 'gpt-6-astra', skills: ['oc-builder'] } },
    ]);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const raw = serializeHarnessTable(edited.table);
    const restored = parseHarnessTable(raw);
    const b1 = restored.categories.flatMap((c) => c.types).find((t) => t.typeId === 'B1');
    expect(b1?.values.cli).toBe('codex');
    expect(b1?.values.skills).toEqual(['oc-builder']);
  });

  it('corrupt/missing payload falls back to factory — never throws', () => {
    expect(parseHarnessTable(null).categories.length).toBeGreaterThan(0);
    expect(parseHarnessTable('x').categories.length).toBeGreaterThan(0);
    expect(parseHarnessTable({ categories: [] }).categories.length).toBeGreaterThan(0);
    expect(
      parseHarnessTable({ categories: [{ categoryId: 'c', name: 'C', types: [{ typeId: 't', name: 'T', values: { effort: 'ultra' } }] }] })
        .categories[0].types[0].values.effort,
    ).toBeUndefined();
  });
});
