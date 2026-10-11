import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// O ledger de proveniência do T3 Code descreve cada arquivo com o hash do
// conteúdo no Nexus. Sem esta checagem ele envelheceu em silêncio: a revisão
// da onda T3 nas telas achou 13 entradas com hash de uma versão anterior.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledger = JSON.parse(
  fs.readFileSync(path.join(root, 'third_party', 'provenance', 't3code-26285ab.json'), 'utf8'),
);

function entries(node, out = []) {
  if (Array.isArray(node)) for (const value of node) entries(value, out);
  else if (node && typeof node === 'object') {
    if (typeof node.nexusPath === 'string') out.push(node);
    for (const value of Object.values(node)) entries(value, out);
  }
  return out;
}

const files = entries(ledger);

describe('ledger de proveniência T3 Code', () => {
  it('lista arquivos', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files.filter((entry) => entry.status !== 'removed').map((entry) => [entry.nexusPath, entry]))(
    '%s existe e o hash bate com o conteúdo',
    (nexusPath, entry) => {
      const file = path.join(root, nexusPath);
      expect(fs.existsSync(file), `${nexusPath} sumiu: marque status "removed" no ledger`).toBe(true);
      const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      expect(hash, `${nexusPath} mudou: atualize nexusSha256 e o changeSummary`).toBe(entry.nexusSha256);
    },
  );

  it('entrada removida não tem mais arquivo no repositório', () => {
    for (const entry of files.filter((item) => item.status === 'removed')) {
      expect(fs.existsSync(path.join(root, entry.nexusPath)), entry.nexusPath).toBe(false);
    }
  });
});
