import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  minimaxNodeRuntimeForSpawn,
  prepareMinimaxNodeRuntime,
  probeNodeAddon,
  resetMinimaxNodeRuntimeForTests,
  type NodeAddonProbeResult,
} from './minimax-node-runtime';

const roots: string[] = [];
afterEach(() => {
  resetMinimaxNodeRuntimeForTests();
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

/** Instalação npm do mcode (como em ~/.npm-global) e dois Nodes no PATH. */
function installation() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcode-node-')));
  roots.push(root);
  const pkg = path.join(root, 'lib', 'node_modules', '@minimax-ai', 'code');
  const addonDir = path.join(pkg, 'node_modules', 'better-sqlite3', 'build', 'Release');
  fs.mkdirSync(addonDir, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: '@minimax-ai/code', bin: { mcode: './cli.js', 'mcode-tools': './mcode-tools.js' },
  }));
  const entry = path.join(pkg, 'cli.js');
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');
  const addon = path.join(addonDir, 'better_sqlite3.node');
  fs.writeFileSync(addon, 'abi-147');
  const bin = path.join(root, 'bin', 'mcode');
  fs.mkdirSync(path.dirname(bin));
  fs.symlinkSync(entry, bin);
  const nodes = ['node22', 'node26'].map((version) => {
    const dir = path.join(root, version, 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const node = path.join(dir, 'node');
    fs.writeFileSync(node, '', { mode: 0o755 });
    return node;
  });
  const pathEnv = nodes.map((node) => path.dirname(node)).join(path.delimiter);
  return { root, pkg, entry, addon, bin, nodes, pathEnv };
}

/** Sonda falsa: o Node 26 carrega o addon, o 22 não. */
function abiProbe(compatible: string, other: NodeAddonProbeResult = 'fails') {
  return vi.fn(async (node: string): Promise<NodeAddonProbeResult> =>
    node === compatible ? 'loads' : other);
}

describe('MiniMax: Node que carrega o SQLite nativo do mcode (F-789)', () => {
  it('o Node do shebang não carrega o addon: o spawn abre pelo Node que carrega, com o entrypoint real', async () => {
    const fx = installation();
    const probe = abiProbe(fx.nodes[1]!);
    const runtime = await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe);
    expect(runtime).toEqual({ kind: 'pinned', launch: { file: fx.nodes[1], argsPrefix: [fx.entry] } });
    expect(probe.mock.calls).toEqual([[fx.nodes[0], fx.addon], [fx.nodes[1], fx.addon]]);
    // O spawn síncrono só lê a decisão pronta para o mesmo lançador e PATH.
    expect(minimaxNodeRuntimeForSpawn(fx.bin, fx.pathEnv)).toEqual(runtime);
    expect(minimaxNodeRuntimeForSpawn(fx.bin, `/outro${path.delimiter}${fx.pathEnv}`)).toBeUndefined();
    expect(minimaxNodeRuntimeForSpawn(path.join(fx.root, 'outro'), fx.pathEnv)).toBeUndefined();
  });

  it('o Node do shebang carrega o addon: nada muda e só ele é sondado', async () => {
    const fx = installation();
    const probe = abiProbe(fx.nodes[0]!);
    expect(await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe)).toEqual({ kind: 'default' });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('nenhum Node do PATH carrega: incompatível, sem recompilar nem reinstalar nada', async () => {
    const fx = installation();
    const before = fs.readFileSync(fx.addon, 'utf8');
    const probe = vi.fn(async (): Promise<NodeAddonProbeResult> => 'fails');
    expect(await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe)).toEqual({ kind: 'incompatible' });
    expect(fs.readFileSync(fx.addon, 'utf8')).toBe(before);
  });

  it('sem prova (timeout) mantém o shebang e não fica em cache', async () => {
    const fx = installation();
    const probe = vi.fn(async (): Promise<NodeAddonProbeResult> => 'unknown');
    expect(await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe)).toEqual({ kind: 'default' });
    await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('cache por realpath+mtime: spawn seguinte não sonda; addon reinstalado sonda de novo', async () => {
    const fx = installation();
    const probe = abiProbe(fx.nodes[1]!);
    await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe);
    await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe);
    expect(probe).toHaveBeenCalledTimes(2);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(fx.addon, later, later);
    await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe);
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('Node repetido por symlink conta uma vez; link quebrado no PATH é pulado como o env faz', async () => {
    const fx = installation();
    const alias = path.join(fx.root, 'alias');
    const broken = path.join(fx.root, 'broken');
    fs.mkdirSync(alias);
    fs.mkdirSync(broken);
    fs.symlinkSync(fx.nodes[0]!, path.join(alias, 'node'));
    fs.symlinkSync(path.join(fx.root, 'sumiu', 'node'), path.join(broken, 'node'));
    const pathEnv = [broken, path.dirname(fx.nodes[0]!), alias, path.dirname(fx.nodes[1]!)]
      .join(path.delimiter);
    const probe = abiProbe(fx.nodes[1]!);
    await prepareMinimaxNodeRuntime(fx.bin, pathEnv, probe);
    expect(probe.mock.calls.map(([node]) => node)).toEqual([fx.nodes[0], fx.nodes[1]]);
  });

  it('outro pacote ou instalação sem o addon: nenhuma sonda, spawn normal', async () => {
    const fx = installation();
    const probe = vi.fn(async (): Promise<NodeAddonProbeResult> => 'fails');
    fs.writeFileSync(path.join(fx.pkg, 'package.json'), JSON.stringify({ name: 'outro', bin: { mcode: './cli.js' } }));
    expect(await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe)).toEqual({ kind: 'default' });
    fs.writeFileSync(path.join(fx.pkg, 'package.json'), JSON.stringify({ name: '@minimax-ai/code', bin: { mcode: './cli.js' } }));
    fs.rmSync(fx.addon);
    expect(await prepareMinimaxNodeRuntime(fx.bin, fx.pathEnv, probe)).toEqual({ kind: 'default' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('sonda real: addon que o Node não carrega dá "fails"; Node inexistente dá "unknown"', async () => {
    const fx = installation();
    await expect(probeNodeAddon(process.execPath, fx.addon)).resolves.toBe('fails');
    await expect(probeNodeAddon(path.join(fx.root, 'sem-node'), fx.addon)).resolves.toBe('unknown');
  });
});
