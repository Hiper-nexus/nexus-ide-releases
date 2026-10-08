// QLT-07: casos no `RuleTester` do oxlint, mais a trava do teto: cada arquivo
// da lista roda com o código de verdade — com o teto da lista passa, com o
// teto menos um acusa exatamente uma chamada. Teto folgado (canal migrado sem
// baixar o número) ou arquivo que sumiu reprovam aqui.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';
import plugin from '../index.mjs';
import rule, { NO_RAW_IPC_MESSAGE, RAW_IPC_ALLOWLIST } from './no-raw-ipc.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const error = (line) => ({ message: NO_RAW_IPC_MESSAGE, line });

describe('plugin nexus', () => {
  it('registra no-raw-ipc com o nome que o .oxlintrc.json liga', () => {
    expect(plugin.rules['no-raw-ipc']).toBe(rule);
  });

  it('toda exceção existe e diz por quê', () => {
    for (const [file, entry] of Object.entries(RAW_IPC_ALLOWLIST)) {
      expect(fs.existsSync(path.join(REPO, file)), file).toBe(true);
      expect(entry.max, file).toBeGreaterThan(0);
      expect(entry.reason.trim().length, file).toBeGreaterThan(10);
    }
  });
});

new RuleTester().run('nexus/no-raw-ipc', rule, {
  valid: [
    {
      name: 'wrapper confiável e remoção de handler passam',
      filename: 'src/main/novo-ipc.ts',
      code: `
        handleTrusted(CHANNELS.list, () => []);
        onTrusted(CHANNELS.ping, () => {});
        ipcMain.removeHandler(CHANNELS.list);
      `,
    },
    {
      name: 'testes e scripts ficam de fora',
      filename: 'src/main/novo-ipc.test.ts',
      code: `ipcMain.handle('x', () => 1);`,
    },
    {
      name: 'script que sobe um Electron próprio fica de fora',
      filename: 'scripts/check-browser-profile-ui.mjs',
      code: `ipcMain.handle('x', () => 1);`,
    },
    {
      name: 'arquivo da lista dentro do teto',
      filename: 'src/main/security/trusted-ipc.ts',
      code: `ipcMain.handle(channel, a); ipcMain.on(channel, b);`,
    },
  ],
  invalid: [
    {
      name: 'acusa ipcMain.handle e ipcMain.on crus em arquivo novo',
      filename: 'src/main/novo-ipc.ts',
      code: `
        ipcMain.handle(CHANNELS.list, () => []);
        electron.ipcMain.on(CHANNELS.ping, () => {});
      `,
      errors: [error(2), error(3)],
    },
    {
      name: 'acusa ipcRenderer cru fora das pontes do preload',
      filename: 'src/renderer/lib/atalho.ts',
      code: `ipcRenderer.invoke('orch:list'); ipcRenderer.send('x');`,
      errors: [error(1), error(1)],
    },
    {
      name: 'acusa a chamada acima do teto de um arquivo da lista',
      filename: 'src/main/security/trusted-ipc.ts',
      code: `
        ipcMain.handle(channel, a);
        ipcMain.on(channel, b);
        ipcMain.handle('extra', c);
      `,
      errors: [error(4)],
    },
  ],
});

// O teto de cada arquivo é exato, medido pela própria regra no código real.
const ceilingCases = Object.entries(RAW_IPC_ALLOWLIST).map(([file, entry]) => ({
  file,
  entry,
  code: fs.readFileSync(path.join(REPO, file), 'utf8'),
}));

new RuleTester().run('nexus/no-raw-ipc (teto exato da lista)', rule, {
  valid: ceilingCases.map(({ file, code }) => ({
    name: `${file} cabe no teto`,
    filename: file,
    code,
  })),
  invalid: ceilingCases.map(({ file, entry, code }) => ({
    name: `${file} com teto ${entry.max - 1} acusa uma chamada`,
    filename: file,
    code,
    options: [{ allowlist: { [file]: { max: entry.max - 1 } } }],
    errors: [{ message: NO_RAW_IPC_MESSAGE }],
  })),
});
