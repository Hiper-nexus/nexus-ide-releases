import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanInstalledPlugins } from './agent-plugin-scan';

let home: string;

function writePlugin(
  root: string,
  name: string,
  manifest: unknown,
  manifestPath = 'plugin.json',
): void {
  const dir = path.join(home, root, name);
  fs.mkdirSync(path.dirname(path.join(dir, manifestPath)), { recursive: true });
  fs.writeFileSync(
    path.join(dir, manifestPath),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-plugin-scan-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('varredura de plugins instalados', () => {
  it('HOME sem diretório de plugin nenhum devolve lista vazia, não erro', () => {
    expect(scanInstalledPlugins(home)).toEqual([]);
  });

  it('encontra plugin válido nas duas raízes de convenção', () => {
    writePlugin('.nexus/plugins', 'kit-a', {
      name: 'kit-a',
      version: '1.0.0',
      agents: ['revisor'],
    });
    writePlugin('.claude/plugins', 'kit-b', {
      name: 'kit-b',
      version: '2.0.0',
      skills: ['diagramar'],
    });

    const found = scanInstalledPlugins(home);
    expect(found.map((p) => p.verdict.ok)).toEqual([true, true]);
    expect(found.map((p) => p.summary.split(' ')[0]).sort()).toEqual([
      'kit-a',
      'kit-b',
    ]);
  });

  it('lê o manifesto aninhado em .claude-plugin/', () => {
    writePlugin(
      '.claude/plugins',
      'aninhado',
      { name: 'aninhado', version: '1.0.0', skills: ['x'] },
      '.claude-plugin/plugin.json',
    );

    const [found] = scanInstalledPlugins(home);
    expect(found?.verdict.ok).toBe(true);
  });

  /**
   * A regra que mantém a varredura útil: um plugin ruim não pode derrubar os
   * outros. JSON quebrado vira LINHA de relatório, não exceção.
   */
  it('json quebrado não derruba a varredura dos vizinhos', () => {
    writePlugin('.nexus/plugins', 'quebrado', '{ isso não é json');
    writePlugin('.nexus/plugins', 'bom', {
      name: 'bom',
      version: '1.0.0',
      agents: ['a'],
    });

    const found = scanInstalledPlugins(home);
    expect(found).toHaveLength(2);
    expect(found.filter((p) => p.verdict.ok)).toHaveLength(1);
  });

  it('diretório sem manifesto aparece com o motivo, em vez de sumir', () => {
    fs.mkdirSync(path.join(home, '.nexus/plugins', 'orfao'), {
      recursive: true,
    });

    const [found] = scanInstalledPlugins(home);
    expect(found?.verdict.ok).toBe(false);
    expect(found?.summary).toContain('sem plugin.json legível');
  });

  it('nunca devolve caminho absoluto — a origem é relativa ao HOME', () => {
    writePlugin('.nexus/plugins', 'kit', {
      name: 'kit',
      version: '1.0.0',
      agents: ['a'],
    });

    const [found] = scanInstalledPlugins(home);
    expect(found?.source.startsWith('~/')).toBe(true);
    expect(found?.source).not.toContain(home);
  });

  it('degradação chega até o relatório da varredura', () => {
    writePlugin('.nexus/plugins', 'kit', {
      name: 'kit',
      version: '1.0.0',
      agents: ['a'],
      mcpServers: ['s'],
    });

    const [found] = scanInstalledPlugins(home);
    expect(found?.summary).toContain('ignorado: mcpServers');
  });
});
