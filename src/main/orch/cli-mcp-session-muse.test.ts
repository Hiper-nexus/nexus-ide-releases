import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureMuseNexusMcpRegistration,
  museSettingsPath,
  museSupportsMcp,
  parseMuseVersion,
  prepareMuseMcpSession,
} from './cli-mcp-session-muse';
import { minimaxBridgePath } from './cli-mcp-session-minimax';

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-muse-mcp-'));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function writeSettings(home: string, content: string): string {
  const file = museSettingsPath(home, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function fileMode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

const SESSION = { url: 'http://127.0.0.1:9/mcp', token: 'secret-token-xyz' };

describe('Muse Code recebe o MCP do Nexus pelo settings.json (F-696)', () => {
  it('lê a versão do --version e exige 1.4+ (1.4.1 medido com MCP)', () => {
    expect(parseMuseVersion('Muse Code 1.4.1 (1.4.1-R4503.1)\n')).toBe('1.4.1');
    expect(museSupportsMcp('1.4.1')).toBe(true);
    expect(museSupportsMcp('1.4.0')).toBe(true);
    expect(museSupportsMcp('1.3.0')).toBe(false);
    expect(museSupportsMcp(null)).toBe(false);
  });

  it('mescla mcpServers.nexus sem tocar no resto e é idempotente', () => {
    const home = tempHome();
    const file = writeSettings(home, JSON.stringify({
      schema_version: 1,
      provider: 'meta',
      model: 'muse-spark-1.3-contributor',
      mcpServers: { github: { url: 'https://example.test/mcp' } },
    }));
    const options = { home, xdgConfigHome: '', nodePath: 'C:\\node\\node.exe', museVersion: '1.4.1', session: SESSION };
    expect(ensureMuseNexusMcpRegistration(options)).toEqual({ registered: true });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings.provider).toBe('meta');
    expect(settings.model).toBe('muse-spark-1.3-contributor');
    expect(settings.mcpServers.github).toEqual({ url: 'https://example.test/mcp' });
    expect(settings.mcpServers.nexus).toEqual({
      command: 'C:\\node\\node.exe',
      args: [minimaxBridgePath(home)],
      env: { NEXUS_MCP_URL: SESSION.url, NEXUS_MCP_TOKEN: SESSION.token },
    });
    expect(fs.existsSync(minimaxBridgePath(home))).toBe(true);
    const mtime = fs.statSync(file).mtimeMs;
    expect(ensureMuseNexusMcpRegistration(options)).toEqual({ registered: true });
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('settings.json quebrado nunca é sobrescrito; o pane segue sem ENV do MCP', () => {
    const home = tempHome();
    const file = writeSettings(home, '{ not json');
    const prepared = prepareMuseMcpSession('http://127.0.0.1:1/mcp', 'secret-token', {
      home, xdgConfigHome: '', nodePath: 'node', museVersion: '1.4.1',
    });
    expect(prepared.registered).toBe(false);
    expect(prepared.env).toEqual({});
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('Muse sem MCP (anterior ao 1.4) não tem o settings.json tocado', () => {
    const home = tempHome();
    const file = writeSettings(home, '{"schema_version":1}');
    const prepared = prepareMuseMcpSession('http://127.0.0.1:1/mcp', 'secret-token', {
      home, xdgConfigHome: '', nodePath: 'node', museVersion: '1.3.0',
    });
    expect(prepared.registered).toBe(false);
    expect(prepared.env).toEqual({});
    expect(fs.readFileSync(file, 'utf8')).toBe('{"schema_version":1}');
  });

  it('a sessão viaja no env da entrada e o arquivo é travado em 0600 (F-1338)', () => {
    const home = tempHome();
    const file = writeSettings(home, '{"schema_version":1}');
    const prepared = prepareMuseMcpSession('http://127.0.0.1:9/mcp', 'secret-token-xyz', {
      home, xdgConfigHome: '', nodePath: 'node', museVersion: '1.4.1',
    });
    expect(prepared.registered).toBe(true);
    expect(prepared.env).toEqual({ NEXUS_MCP_URL: 'http://127.0.0.1:9/mcp', NEXUS_MCP_TOKEN: 'secret-token-xyz' });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings.mcpServers.nexus.env).toEqual({
      NEXUS_MCP_URL: 'http://127.0.0.1:9/mcp',
      NEXUS_MCP_TOKEN: 'secret-token-xyz',
    });
    if (process.platform !== 'win32') expect(fileMode(file)).toBe(0o600);
  });

  it('sem sessão nada é registrado: entrada sem env nunca entrega ferramentas (F-1338)', () => {
    const home = tempHome();
    const file = writeSettings(home, '{"schema_version":1}');
    expect(
      ensureMuseNexusMcpRegistration({ home, xdgConfigHome: '', nodePath: 'node', museVersion: '1.4.1' }),
    ).toEqual({
      registered: false,
      reason: expect.stringMatching(/sessão MCP ausente/),
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"schema_version":1}');
  });

  it('cria schema_version quando o arquivo não tem (Muse 1.4.4 recusa sem ele)', () => {
    const home = tempHome();
    const file = museSettingsPath(home, '');
    expect(fs.existsSync(file)).toBe(false);
    expect(
      ensureMuseNexusMcpRegistration({ home, xdgConfigHome: '', nodePath: 'node', museVersion: '1.4.1', session: SESSION }),
    ).toEqual({ registered: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).schema_version).toBe(1);
  });

  it('respeita XDG_CONFIG_HOME como o próprio Muse', () => {
    expect(museSettingsPath('/home/op', '/xdg')).toBe(path.join('/xdg', 'muse', 'settings.json'));
    expect(museSettingsPath('/home/op', '')).toBe(path.join('/home/op', '.config', 'muse', 'settings.json'));
  });
});
