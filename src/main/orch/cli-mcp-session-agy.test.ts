import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agyListHasNexusBridge,
  ensureAgyNexusMcpRegistration,
  resetAgyMcpRegistrationForTests,
  type AgyCliExec,
} from './cli-mcp-session-agy';
import { minimaxBridgePath } from './cli-mcp-session-minimax';

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agy-mcp-'));
  homes.push(home);
  return home;
}
beforeEach(() => resetAgyMcpRegistrationForTests());
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** CLI falsa com o formato medido no `agy mcp list` 1.2.14. */
function fakeAgy(initial: string[] = []) {
  const servers = [...initial];
  const calls: string[][] = [];
  const exec: AgyCliExec = (_bin, args) => {
    calls.push([...args]);
    if (args[0] === 'mcp' && args[1] === 'list') {
      return servers.length === 0
        ? 'No MCP servers configured.\n'
        : `NAME  TYPE   STATUS   COMMAND/URL\n${servers.join('\n')}\n`;
    }
    if (args[0] === 'mcp' && args[1] === 'add') {
      const [, , name, command, bridge] = args;
      const line = `${name}  stdio  enabled  ${command} ${bridge}`;
      const index = servers.findIndex((row) => row.startsWith(`${name} `));
      if (index >= 0) servers[index] = line;
      else servers.push(line);
      return '';
    }
    throw new Error(`unexpected agy ${args.join(' ')}`);
  };
  return { exec, calls, servers };
}

describe('AGY recebe o MCP do Nexus pela ponte no perfil nativo (F-697)', () => {
  it('lê o `agy mcp list` e só aceita a entrada nexus habilitada desta ponte', () => {
    const bridge = 'C:\\Users\\op\\.nexus\\mcp-bridge\\nexus-mcp-bridge.cjs';
    const list = `NAME TYPE STATUS COMMAND/URL\nnexus stdio enabled C:\\node\\node.exe ${bridge}\n`;
    expect(agyListHasNexusBridge(list, bridge)).toBe(true);
    expect(agyListHasNexusBridge(list.replace('enabled', 'disabled'), bridge)).toBe(false);
    expect(agyListHasNexusBridge('No MCP servers configured.', bridge)).toBe(false);
    expect(agyListHasNexusBridge(`nexus stdio enabled C:\\node\\node.exe C:\\outra\\ponte.cjs`, bridge)).toBe(false);
  });

  it('registra pela própria CLI quando falta e memoriza no processo', () => {
    const home = tempHome();
    const agy = fakeAgy(['github  http  enabled  https://example.test/mcp']);
    const options = { home, agyBin: 'agy', nodePath: 'C:\\node\\node.exe', exec: agy.exec };
    expect(ensureAgyNexusMcpRegistration(options)).toEqual({ registered: true });
    expect(agy.calls).toContainEqual(['mcp', 'add', 'nexus', 'C:\\node\\node.exe', minimaxBridgePath(home)]);
    expect(agy.servers[0]).toContain('github');
    expect(fs.existsSync(minimaxBridgePath(home))).toBe(true);
    const before = agy.calls.length;
    expect(ensureAgyNexusMcpRegistration(options)).toEqual({ registered: true });
    expect(agy.calls.length).toBe(before);
  });

  it('não regrava quando a ponte já está registrada', () => {
    const home = tempHome();
    const bridge = minimaxBridgePath(home);
    const agy = fakeAgy([`nexus  stdio  enabled  C:\\node\\node.exe ${bridge}`]);
    expect(ensureAgyNexusMcpRegistration({ home, agyBin: 'agy', nodePath: 'C:\\node\\node.exe', exec: agy.exec }))
      .toEqual({ registered: true });
    expect(agy.calls.some((call) => call[1] === 'add')).toBe(false);
  });

  it('falha com motivo quando a CLI não responde (o spawn de missão recusa)', () => {
    const home = tempHome();
    const exec: AgyCliExec = () => {
      throw new Error('spawn agy ENOENT');
    };
    const result = ensureAgyNexusMcpRegistration({ home, agyBin: 'agy', nodePath: 'node', exec });
    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/ENOENT/);
  });
});
