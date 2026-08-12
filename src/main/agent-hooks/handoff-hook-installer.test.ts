import { describe, expect, it } from 'vitest';
import { interpolateHookShebangNodePath } from './handoff-hook-installer';

const POLYGLOT_SOURCE = `#!/bin/sh
':' //# ; exec process.execPath "$0" "$@"
import { readFileSync } from 'node:fs'
`;

describe('interpolateHookShebangNodePath', () => {
  it('substitui o placeholder pelo caminho absoluto do Node entre aspas simples', () => {
    const result = interpolateHookShebangNodePath(POLYGLOT_SOURCE, '/usr/local/bin/node');
    expect(result).toContain("exec '/usr/local/bin/node' \"$0\" \"$@\"");
    expect(result).not.toContain('exec process.execPath');
    // corpo ESM preservado
    expect(result).toContain("import { readFileSync } from 'node:fs'");
  });

  it('escapa aspas simples no caminho (escape POSIX para /bin/sh)', () => {
    // caminho patológico com aspa — precisa sobreviver ao exec do shell
    const weird = "/home/o'reilly/node";
    const result = interpolateHookShebangNodePath(POLYGLOT_SOURCE, weird);
    expect(result).toContain("exec '/home/o'\\''reilly/node' \"$0\" \"$@\"");
  });

  it('envolve com ELECTRON_RUN_AS_NODE=1 quando runAsNode=true (Electron empacotado)', () => {
    // Em produção process.execPath é o binário do Electron; sem o wrapper
    // `env ELECTRON_RUN_AS_NODE=1` ele abriria uma janela em vez de rodar o
    // script. Convenção espelhada de acp-mcp-stdio-bridge.ts:132.
    const result = interpolateHookShebangNodePath(
      POLYGLOT_SOURCE,
      '/Applications/NexusIDE.app/Contents/MacOS/NexusIDE',
      true,
    );
    expect(result).toContain(
      "exec env ELECTRON_RUN_AS_NODE=1 '/Applications/NexusIDE.app/Contents/MacOS/NexusIDE' \"$0\" \"$@\"",
    );
    expect(result).not.toContain('exec process.execPath');
  });

  it('é idempotente: segunda chamada com mesmo caminho não altera', () => {
    const once = interpolateHookShebangNodePath(POLYGLOT_SOURCE, '/n/node');
    const twice = interpolateHookShebangNodePath(once, '/n/node');
    expect(twice).toBe(once);
  });

  it('retorna inalterado se o placeholder não estiver presente', () => {
    const already = `#!/bin/sh
':' //# ; exec '/opt/node' "$0" "$@"
`;
    expect(interpolateHookShebangNodePath(already, '/other/node')).toBe(already);
  });
});
