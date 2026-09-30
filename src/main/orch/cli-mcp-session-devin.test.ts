import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  devinListHasNexusBridge,
  ensureDevinNexusMcpRegistration,
  resetDevinMcpRegistrationForTests,
  type DevinCliExec,
} from './cli-mcp-session-devin';
import { minimaxBridgePath } from './cli-mcp-session-minimax';

const homes: string[] = [];
function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-devin-mcp-'));
  homes.push(home);
  return home;
}
beforeEach(() => resetDevinMcpRegistrationForTests());
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** CLI falsa no formato medido do `devin mcp list` 3000.11.1. */
function fakeDevin(initial: Array<{ name: string; command: string }> = []) {
  const servers = [...initial];
  const calls: string[][] = [];
  const exec: DevinCliExec = (_bin, args) => {
    calls.push([...args]);
    if (args[1] === 'list') {
      return `Configured MCP servers:\n\n${servers.map((s) => `  • ${s.name}\n    Command: ${s.command}\n`).join('\n')}`;
    }
    if (args[1] === 'remove') {
      const index = servers.findIndex((s) => s.name === args[4]);
      if (index < 0) throw new Error('not found');
      servers.splice(index, 1);
      return '';
    }
    if (args[1] === 'add') {
      expect(args.slice(0, 5)).toEqual(['mcp', 'add', '--scope', 'user', 'nexus']);
      const [, , , , name, , node, bridge] = args;
      servers.push({ name: name!, command: `${node} ${bridge}` });
      return '';
    }
    throw new Error(`unexpected devin ${args.join(' ')}`);
  };
  return { exec, calls, servers };
}

describe('Devin recebe o MCP do Nexus pela ponte no escopo de usuário (F-698)', () => {
  it('lê o `devin mcp list` e só aceita a entrada nexus desta ponte', () => {
    const bridge = 'C:\\Users\\op\\.nexus\\mcp-bridge\\nexus-mcp-bridge.cjs';
    const list = `Configured MCP servers:\n\n  • node_repl\n    Command: C:\\x\\node_repl.exe\n\n  • nexus\n    Command: C:\\node\\node.exe ${bridge}\n`;
    expect(devinListHasNexusBridge(list, bridge)).toBe(true);
    expect(devinListHasNexusBridge(list.replace('• nexus', '• nexus (disabled)'), bridge)).toBe(false);
    expect(devinListHasNexusBridge('Configured MCP servers:\n\n  • node_repl\n    Command: x\n', bridge)).toBe(false);
  });

  it('registra no escopo de usuário quando falta, preserva os outros servidores e memoriza', () => {
    const home = tempHome();
    const devin = fakeDevin([{ name: 'node_repl', command: 'C:\\x\\node_repl.exe' }]);
    const options = { home, devinBin: 'devin', nodePath: 'C:\\node\\node.exe', exec: devin.exec };
    expect(ensureDevinNexusMcpRegistration(options)).toEqual({ registered: true });
    expect(devin.calls).toContainEqual(['mcp', 'add', '--scope', 'user', 'nexus', '--', 'C:\\node\\node.exe', minimaxBridgePath(home)]);
    expect(devin.servers.map((s) => s.name)).toEqual(['node_repl', 'nexus']);
    const before = devin.calls.length;
    expect(ensureDevinNexusMcpRegistration(options)).toEqual({ registered: true });
    expect(devin.calls.length).toBe(before);
  });

  it('substitui uma entrada nexus antiga que aponta para outra ponte', () => {
    const home = tempHome();
    const devin = fakeDevin([{ name: 'nexus', command: 'node C:\\velha\\ponte.cjs' }]);
    expect(ensureDevinNexusMcpRegistration({ home, devinBin: 'devin', nodePath: 'node', exec: devin.exec }))
      .toEqual({ registered: true });
    expect(devin.servers).toEqual([{ name: 'nexus', command: `node ${minimaxBridgePath(home)}` }]);
  });

  it('falha com motivo quando a CLI não responde (o spawn de missão recusa)', () => {
    const home = tempHome();
    const exec: DevinCliExec = () => {
      throw new Error('spawn devin ENOENT');
    };
    const result = ensureDevinNexusMcpRegistration({ home, devinBin: 'devin', nodePath: 'node', exec });
    expect(result.registered).toBe(false);
    expect(result.reason).toMatch(/ENOENT/);
  });
});
