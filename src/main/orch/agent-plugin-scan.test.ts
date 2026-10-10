import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST_SCHEMA } from './agent-plugin-manifest';
import { scanInstalledPlugins } from './agent-plugin-scan';

/** Manifesto mínimo VÁLIDO segundo a spec: $schema seleciona a versão. */
function manifest(name: string, extra: Record<string, unknown> = {}) {
  return { $schema: PLUGIN_MANIFEST_SCHEMA, name, version: '1.0.0', ...extra };
}

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

function writePluginFile(root: string, plugin: string, relative: string, body: string): string {
  const file = path.join(home, root, plugin, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function validSkill(name: string, allowedTools?: string): string {
  return `---
name: ${name}
description: ${name} does useful work. Use it when ${name} is requested.
${allowedTools ? `allowed-tools: ${allowedTools}\n` : ''}---

# ${name}

Follow the user's request.
`;
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
    writePlugin('.nexus/plugins', 'kit-a', manifest('kit-a'));
    writePlugin('.claude/plugins', 'kit-b', manifest('kit-b'));

    const found = scanInstalledPlugins(home);
    expect(found.map((p) => p.verdict.ok)).toEqual([true, true]);
    expect(found.map((p) => p.summary.split(' ')[0]).sort()).toEqual([
      'kit-a',
      'kit-b',
    ]);
  });

  it('does not mistake the legacy Claude manifest path for Agent Plugins v1', () => {
    writePlugin(
      '.claude/plugins',
      'aninhado',
      manifest('aninhado'),
      '.claude-plugin/plugin.json',
    );

    const [found] = scanInstalledPlugins(home);
    expect(found?.verdict.ok).toBe(false);
    expect(found?.summary).toContain('plugin.json: arquivo ausente');
  });

  /**
   * A regra que mantém a varredura útil: um plugin ruim não pode derrubar os
   * outros. JSON quebrado vira LINHA de relatório, não exceção.
   */
  it('json quebrado não derruba a varredura dos vizinhos', () => {
    writePlugin('.nexus/plugins', 'quebrado', '{ isso não é json');
    writePlugin('.nexus/plugins', 'bom', manifest('bom'));

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
    expect(found?.summary).toContain('plugin.json: arquivo ausente');
  });

  it('nunca devolve caminho absoluto — a origem é relativa ao HOME', () => {
    writePlugin('.nexus/plugins', 'kit', manifest('kit'));

    const [found] = scanInstalledPlugins(home);
    expect(found?.source.startsWith('~/')).toBe(true);
    expect(found?.source).not.toContain(home);
  });

  it('degradação chega até o relatório da varredura', () => {
    // Campo raiz desconhecido: a spec manda ignorar sem invalidar (§5.2) — e a
    // varredura tem de CARREGAR essa perda até o relatório, senão "instalei
    // tudo" vira mentira uma camada acima.
    writePlugin('.nexus/plugins', 'kit', manifest('kit', { hooks: ['./h.json'] }));

    const [found] = scanInstalledPlugins(home);
    expect(found?.summary).toContain('ignorado: hooks');
  });

  it('ingests a real package into catalog and MCP mappings without executing it', () => {
    writePlugin('.nexus/plugins', 'acme-tools', manifest('acme-tools'));
    writePluginFile(
      '.nexus/plugins',
      'acme-tools',
      'skills/review/SKILL.md',
      validSkill(
        'review',
        'Read Bash(git:*) nexus_file_read nexus_file_write nexus_git_push',
      ),
    );
    const sentinel = path.join(home, 'MUST_NOT_EXIST');
    const command = writePluginFile(
      '.nexus/plugins',
      'acme-tools',
      'bin/server.sh',
      `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`,
    );
    fs.chmodSync(command, 0o755);
    writePluginFile(
      '.nexus/plugins',
      'acme-tools',
      'mcp.json',
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          local: { type: 'stdio', command: './bin/server.sh' },
        },
      }),
    );

    const [plugin] = scanInstalledPlugins(home, {
      allowedTools: ['nexus_file_read'],
    });

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(plugin).toMatchObject({
      status: 'degraded',
      skills: [
        {
          name: 'review',
          qualifiedName: 'acme-tools:review',
          catalogEntry: {
            kind: 'skill',
            name: 'acme-tools:review',
          },
          // F-1157: toda tool do Nexus pedida pela skill é concedida; só as
          // entradas nativas (Read, Bash(...)) saem — e seguem degradando.
          toolReduction: {
            granted: ['nexus_file_read', 'nexus_file_write', 'nexus_git_push'],
            removed: ['Read', 'Bash(git:*)'],
          },
        },
      ],
      mcpServers: [
        {
          name: 'local',
          transport: 'stdio',
          activation: 'explicit-user-action',
          permissionGate: 'PreToolUse',
          nexusConcept: 'mcp-hub-server',
        },
      ],
    });
    expect(plugin?.summary).toContain('allowed-tools');
    expect(plugin?.mappings).toMatchObject({
      skills: { nexusConcept: 'catalog.skill', loaded: 1, skipped: 0 },
      mcpServers: { nexusConcept: 'mcp-hub.server', loaded: 1, skipped: 0 },
    });
  });

  it('skips a malformed skill while preserving valid skills and MCP servers', () => {
    writePlugin('.nexus/plugins', 'partial', manifest('partial'));
    writePluginFile(
      '.nexus/plugins',
      'partial',
      'skills/good/SKILL.md',
      validSkill('good'),
    );
    writePluginFile(
      '.nexus/plugins',
      'partial',
      'skills/bad/SKILL.md',
      '---\nname: WRONG\n---\n',
    );
    writePluginFile(
      '.nexus/plugins',
      'partial',
      'mcp.json',
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { docs: { type: 'streamable-http', url: 'https://mcp.test' } },
      }),
    );

    const [plugin] = scanInstalledPlugins(home);

    expect(plugin?.status).toBe('degraded');
    expect(plugin?.skills.map((skill) => skill.name)).toEqual(['good']);
    expect(plugin?.mcpServers.map((server) => server.name)).toEqual(['docs']);
    expect(plugin?.notices).toEqual([
      expect.objectContaining({ component: 'skills', entry: 'bad' }),
    ]);
  });

  it('disables malformed mcp.json without losing valid skills', () => {
    writePlugin('.nexus/plugins', 'skills-first', manifest('skills-first'));
    writePluginFile(
      '.nexus/plugins',
      'skills-first',
      'skills/good/SKILL.md',
      validSkill('good'),
    );
    writePluginFile(
      '.nexus/plugins',
      'skills-first',
      'mcp.json',
      '{ not json',
    );

    const [plugin] = scanInstalledPlugins(home);

    expect(plugin?.verdict.ok).toBe(true);
    expect(plugin?.skills).toHaveLength(1);
    expect(plugin?.mcpServers).toEqual([]);
    expect(plugin?.notices).toEqual([
      expect.objectContaining({ component: 'mcpServers' }),
    ]);
  });

  it('quarantines a package whose SKILL.md resolves outside the plugin root', () => {
    writePlugin('.nexus/plugins', 'escape', manifest('escape'));
    const outside = path.join(home, 'outside-skill.md');
    fs.writeFileSync(outside, validSkill('escape'));
    const skillDir = path.join(home, '.nexus/plugins/escape/skills/escape');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.symlinkSync(outside, path.join(skillDir, 'SKILL.md'));

    const [plugin] = scanInstalledPlugins(home);

    expect(plugin?.status).toBe('quarantined');
    expect(plugin?.verdict.ok).toBe(false);
    expect(plugin?.summary).toContain('fora da raiz');
  });

  it('quarantines a package with a skill asset symlink', () => {
    writePlugin('.nexus/plugins', 'asset-escape', manifest('asset-escape'));
    writePluginFile(
      '.nexus/plugins',
      'asset-escape',
      'skills/review/SKILL.md',
      validSkill('review'),
    );
    const outside = path.join(home, 'outside-script.sh');
    fs.writeFileSync(outside, '#!/bin/sh\nexit 0\n');
    fs.symlinkSync(
      outside,
      path.join(
        home,
        '.nexus/plugins/asset-escape/skills/review/run.sh',
      ),
    );

    const [plugin] = scanInstalledPlugins(home);

    expect(plugin?.status).toBe('quarantined');
    expect(plugin?.verdict.ok).toBe(false);
    expect(plugin?.summary).toContain('link simbólico');
  });
});
