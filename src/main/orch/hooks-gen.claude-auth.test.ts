import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupSessionArtifacts, prepareEphemeralHome } from './hooks-gen';

const TOKEN = `claude-auth-test-${process.pid}-${Date.now()}`;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-auth-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  cleanupSessionArtifacts(TOKEN);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('native Claude auth in the ephemeral HOME', () => {
  it('carries oauthAccount/userID (and nothing else) into the stub', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'user@example.com' },
        userID: 'uid-1',
        projects: { '/tmp/foo': { history: ['sensitive'] } },
      }),
    );

    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        carryNativeClaudeAuth: true,
      },
    );

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stub.hasCompletedOnboarding).toBe(true);
    expect(stub.oauthAccount).toEqual({ emailAddress: 'user@example.com' });
    expect(stub.userID).toBe('uid-1');
    expect(stub.projects).toBeUndefined();
  });

  it('carrega a confiança de pasta já concedida — só as flags, só do cwd', () => {
    // Sem isso o pane gated para no diálogo "Do you trust the files in this
    // folder?" esperando uma tecla que ninguém manda: a missão fica "ao vivo"
    // com o orquestrador parado na tela de boas-vindas para sempre.
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          '/work/projeto': {
            hasTrustDialogAccepted: true,
            history: ['prompt sensível'],
            allowedTools: ['Bash'],
          },
          '/work/outro': { hasTrustDialogAccepted: true },
        },
      }),
    );

    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        cwd: '/work/projeto',
      },
    );

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as { projects?: Record<string, Record<string, unknown>> };
    expect(Object.keys(stub.projects ?? {})).toEqual(['/work/projeto']);
    expect(stub.projects?.['/work/projeto']).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
  });

  it('nunca inventa confiança que o usuário não deu', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        projects: { '/work/projeto': { hasTrustDialogAccepted: false } },
      }),
    );

    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        cwd: '/work/projeto',
      },
    );

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stub.projects).toBeUndefined();
  });

  it('projeta confiança só no overlay para o cwd de uma missão já aprovada', () => {
    const realProfile = JSON.stringify({
      projects: {
        '/work/projeto': { hasTrustDialogAccepted: false },
        '/work/outro': { hasTrustDialogAccepted: true },
      },
    });
    fs.writeFileSync(path.join(home, '.claude.json'), realProfile);

    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        cwd: '/work/projeto',
        approvedMissionProjectTrust: true,
      },
    );

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as { projects?: Record<string, Record<string, unknown>> };
    expect(stub.projects).toEqual({
      '/work/projeto': {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe(
      realProfile,
    );
  });

  it('não projeta confiança aprovada sem um cwd exato', () => {
    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        approvedMissionProjectTrust: true,
      },
    );

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stub.projects).toBeUndefined();
  });

  it('never carries the native identity without the flag (GLM/LongCat)', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'user@example.com' } }),
    );

    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} });

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stub.oauthAccount).toBeUndefined();
    expect(stub.hasCompletedOnboarding).toBe(true);
  });

  it('links the file-backed credentials so refreshes write through', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ token: 'secret' }),
    );

    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        carryNativeClaudeAuth: true,
      },
    );

    const linked = path.join(overlay.dir, '.claude', '.credentials.json');
    expect(
      JSON.parse(fs.readFileSync(linked, 'utf8')) as Record<string, unknown>,
    ).toEqual({ token: 'secret' });
  });

  it('rescues a fresh in-pane login into the real profile on teardown', () => {
    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        carryNativeClaudeAuth: true,
      },
    );
    // O CLI faz /login dentro do pane: identidade + segredo nascem no overlay.
    fs.writeFileSync(
      path.join(overlay.dir, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: 'fresh@example.com' },
      }),
    );
    fs.writeFileSync(
      path.join(overlay.dir, '.claude', '.credentials.json'),
      JSON.stringify({ token: 'fresh-secret' }),
    );

    cleanupSessionArtifacts(TOKEN);

    const real = JSON.parse(
      fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
    ) as { oauthAccount?: { emailAddress?: string } };
    expect(real.oauthAccount?.emailAddress).toBe('fresh@example.com');
    expect(fs.existsSync(path.join(home, '.claude', '.credentials.json'))).toBe(
      true,
    );
    expect(fs.existsSync(overlay.dir)).toBe(false);
  });

  it('never clobbers an existing native login on teardown', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'native@example.com' } }),
    );
    const overlay = prepareEphemeralHome(
      TOKEN,
      { mcpServers: {} },
      {
        carryNativeClaudeAuth: true,
      },
    );
    fs.writeFileSync(
      path.join(overlay.dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'other@example.com' },
      }),
    );

    cleanupSessionArtifacts(TOKEN);

    const real = JSON.parse(
      fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
    ) as { oauthAccount?: { emailAddress?: string } };
    expect(real.oauthAccount?.emailAddress).toBe('native@example.com');
  });

  it('syncs nothing back from an overlay without the native-auth marker', () => {
    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} });
    // Um /login dentro de um pane GLM/LongCat autentica contra endpoint de
    // terceiro — essa identidade nunca pode poluir o perfil nativo.
    fs.writeFileSync(
      path.join(overlay.dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'foreign@example.com' },
      }),
    );

    cleanupSessionArtifacts(TOKEN);

    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    expect(fs.existsSync(overlay.dir)).toBe(false);
  });
});

describe('F-567 durable Claude-family conversations', () => {
  it('carries native auth/extensions without copying external conversation metadata', () => {
    const realClaude = path.join(home, '.claude');
    fs.mkdirSync(path.join(realClaude, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(realClaude, '.credentials.json'),
      '{"token":"test-secret"}',
    );
    fs.writeFileSync(
      path.join(realClaude, 'settings.json'),
      JSON.stringify({
        apiKeyHelper: 'operator-key-helper',
        env: {
          CLAUDE_CONFIG_DIR: realClaude,
          HOME: home,
          USERPROFILE: home,
          KEEP: 'yes',
        },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'operator-hook' }] }],
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'operator@example.com' },
        mcpServers: { existing: { command: 'user-mcp' } },
        projects: {
          '/workspace': {
            history: ['external conversation'],
            lastSessionId: 'external-id',
          },
        },
      }),
    );
    const prepared = prepareEphemeralHome(
      TOKEN,
      {},
      {
        userDataPath: path.join(home, 'user-data'),
        checkoutId: 'checkout-a',
        adapterId: 'claude',
        carryNativeClaudeAuth: true,
        inheritNativeProfile: true,
        gateHooks: false,
      },
    );
    const config = path.join(prepared.dir, '.claude');
    expect(prepared.providerProfileReadPaths).toContain(
      fs.realpathSync(path.join(realClaude, 'skills')),
    );
    expect(prepared.providerProfileReadPaths).not.toContain(realClaude);
    expect(fs.realpathSync(path.join(config, '.credentials.json'))).toBe(
      fs.realpathSync(path.join(realClaude, '.credentials.json')),
    );
    expect(fs.realpathSync(path.join(config, 'skills'))).toBe(
      fs.realpathSync(path.join(realClaude, 'skills')),
    );
    const profile = JSON.parse(
      fs.readFileSync(path.join(prepared.dir, '.claude.json'), 'utf8'),
    );
    expect(profile.oauthAccount.emailAddress).toBe('operator@example.com');
    expect(profile.mcpServers.existing.command).toBe('user-mcp');
    expect(profile.projects).toBeUndefined();
    const settings = JSON.parse(
      fs.readFileSync(path.join(config, 'settings.json'), 'utf8'),
    );
    expect(settings.apiKeyHelper).toBe('operator-key-helper');
    expect(settings.env).toEqual({ KEEP: 'yes' });
    expect(JSON.stringify(settings.hooks)).toContain('operator-hook');
    fs.writeFileSync(path.join(config, 'projects', 'pane.jsonl'), 'pane');
    cleanupSessionArtifacts(TOKEN);
    expect(fs.existsSync(path.join(realClaude, 'projects', 'pane.jsonl'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(realClaude, 'history.jsonl'))).toBe(false);
  });

  it.each(['claude', 'glm', 'glm-flash', 'longcat', 'deepseek', 'minimax'])(
    'keeps %s conversations outside the native profile and across spawns',
    (adapterId) => {
      const userDataPath = path.join(home, 'user-data');
      const nativeProjects = path.join(home, '.claude', 'projects');
      fs.mkdirSync(nativeProjects, { recursive: true });
      fs.writeFileSync(path.join(nativeProjects, 'external.jsonl'), 'external');
      const options = {
        userDataPath,
        checkoutId: 'checkout-a',
        adapterId,
        carryNativeClaudeAuth: adapterId === 'claude',
      };
      const first = prepareEphemeralHome(TOKEN, {}, options);
      const projects = path.join(first.dir, '.claude', 'projects');
      const durable = path.join(
        userDataPath,
        'provider-state',
        adapterId,
        'checkout-a',
        'claude',
      );
      expect(fs.realpathSync(projects)).toBe(
        fs.realpathSync(path.join(durable, 'projects')),
      );
      expect(fs.existsSync(path.join(projects, 'external.jsonl'))).toBe(false);
      fs.writeFileSync(
        path.join(projects, 'exact-id.jsonl'),
        'pane conversation',
      );
      fs.appendFileSync(
        path.join(first.dir, '.claude', 'history.jsonl'),
        'pane history',
      );
      cleanupSessionArtifacts(TOKEN);
      expect(fs.existsSync(path.join(nativeProjects, 'exact-id.jsonl'))).toBe(
        false,
      );
      expect(
        fs.readFileSync(path.join(nativeProjects, 'external.jsonl'), 'utf8'),
      ).toBe('external');
      const second = prepareEphemeralHome(
        TOKEN,
        {},
        { ...options, checkoutId: 'checkout-b' },
      );
      expect(
        fs.existsSync(
          path.join(second.dir, '.claude', 'projects', 'exact-id.jsonl'),
        ),
      ).toBe(false);
      cleanupSessionArtifacts(TOKEN);
      const resumed = prepareEphemeralHome(TOKEN, {}, options);
      expect(
        fs.readFileSync(
          path.join(resumed.dir, '.claude', 'projects', 'exact-id.jsonl'),
          'utf8',
        ),
      ).toBe('pane conversation');
      expect(
        fs.readFileSync(
          path.join(resumed.dir, '.claude', 'history.jsonl'),
          'utf8',
        ),
      ).toBe('pane history');
    },
  );
});
