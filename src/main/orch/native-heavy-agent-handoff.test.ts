import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHeavyCommandPreload } from './native-heavy-preload';
import { F958_BRIEF, F958_LONG_UPSTREAM_PATH } from '../../test/f958-brief';

/**
 * F-958: o launcher Node de uma CLI de IA (codex.js → codex nativo,
 * bin/mimo → .mimocode) repassa o PRÓPRIO argv — com o brief da missão — ao
 * binário nativo. O gancho de comandos pesados classificava essa linha pelo
 * texto do brief ("typecheck", "vitest", "Node", > 16 KB) e punha o agente na
 * fila única do projeto: o MiMo ficou mudo em "spawning" e três writers Codex
 * saíram com 74 depois de 300 s. Aqui a "fila" é uma base de job que sai com
 * 74 na hora, como a admissão esgotada do incidente.
 */
const preload = path.join(process.cwd(), 'resources/heavy-command/preload.cjs');
let root = '';
let launcher = '';
let native = '';
let argvOut = '';

function run(entry: string, args: readonly string[], extraEnv: Record<string, string> = {}) {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) if (key.startsWith('NEXUS_HEAVY_')) delete inherited[key];
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    NODE_OPTIONS: appendHeavyCommandPreload(undefined, preload),
    NEXUS_GATE_TOKEN: 'finite',
    NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command',
    NEXUS_HEAVY_JOB_BASE: JSON.stringify({ file: '/usr/bin/perl', args: ['-e', 'exit 74', 'heavy-job'] }),
    NEXUS_TEST_NATIVE: native,
    NEXUS_TEST_ARGV_OUT: argvOut,
    ...extraEnv,
  };
  return spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 20_000 });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f958-handoff-')));
  fs.mkdirSync(path.join(root, 'bin'));
  launcher = path.join(root, 'bin', 'launcher.cjs');
  native = path.join(root, 'bin', 'agent-native');
  argvOut = path.join(root, 'argv.json');
  // Mesmo formato do codex.js/bin/mimo: spawn(nativo, process.argv.slice(2)).
  fs.writeFileSync(
    launcher,
    "const r = require('node:child_process').spawnSync(process.env.NEXUS_TEST_NATIVE, " +
      "process.argv.slice(2), { stdio: 'inherit' }); process.exit(r.status ?? 1);\n",
  );
  // O "binário nativo" grava o argv que recebeu, byte a byte.
  fs.writeFileSync(
    native,
    '#!/usr/bin/perl\nopen(my $f, ">", $ENV{NEXUS_TEST_ARGV_OUT}) or die;\n' +
      'binmode($f, ":raw"); print $f join("\\0", @ARGV); close($f);\n',
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('F-958 — hand-off do launcher do agente', () => {
  it('o brief real chega íntegro ao binário nativo e o agente não entra na fila de pesados', () => {
    expect(F958_BRIEF.length).toBeGreaterThan(3_400);
    expect(F958_BRIEF).toContain('typecheck');
    expect(F958_BRIEF).toContain('`');
    const args = ['--model', 'gpt-6.1-sol', '--prompt', F958_BRIEF];
    const result = run(launcher, args, { NEXUS_HEAVY_AGENT_ENTRY: launcher });
    expect(result.status, result.stderr).toBe(0);
    const received = fs.readFileSync(argvOut, 'utf8').split('\0');
    expect(received).toEqual(args);
    expect(received[3]).toContain(F958_LONG_UPSTREAM_PATH);
  });

  it('brief acima de 16 KB (regra de tamanho do catálogo) também passa direto', () => {
    const big = `${F958_BRIEF}\n\n${'contexto '.repeat(2_000)}`;
    expect(big.length).toBeGreaterThan(16_384);
    const result = run(launcher, ['--prompt', big], { NEXUS_HEAVY_AGENT_ENTRY: launcher });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(argvOut, 'utf8')).toBe(['--prompt', big].join('\0'));
  });

  it('sem a entrada do agente provada pelo Main, o mesmo spawn continua medido (74 da fila)', () => {
    const result = run(launcher, ['--prompt', F958_BRIEF]);
    expect(result.status).toBe(74);
    expect(fs.existsSync(argvOut)).toBe(false);
  });

  it('filho do agente com argv diferente do próprio continua medido', () => {
    const child = path.join(root, 'bin', 'child.cjs');
    fs.writeFileSync(
      child,
      "const r = require('node:child_process').spawnSync(process.env.NEXUS_TEST_NATIVE, " +
        "[...process.argv.slice(2), '--extra'], { stdio: 'inherit' }); process.exit(r.status ?? 1);\n",
    );
    const result = run(child, ['--prompt', F958_BRIEF], { NEXUS_HEAVY_AGENT_ENTRY: child });
    expect(result.status).toBe(74);
    expect(fs.existsSync(argvOut)).toBe(false);
  });

  it('hand-off para um executável pesado pelo nome continua medido', () => {
    const vitestLike = path.join(root, 'bin', 'vitest');
    fs.copyFileSync(native, vitestLike);
    fs.chmodSync(vitestLike, 0o755);
    const result = run(launcher, ['run'], {
      NEXUS_HEAVY_AGENT_ENTRY: launcher,
      NEXUS_TEST_NATIVE: vitestLike,
    });
    expect(result.status).toBe(74);
    expect(fs.existsSync(argvOut)).toBe(false);
  });
});
