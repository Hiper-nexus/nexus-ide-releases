import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../../orch/__tests__/scope-fixture';
import type { BusinessModelDocument } from './business-model-contract';
import {
  configureBusinessModelStore,
  isBusinessModelStoreConfigured,
  readBusinessModelAt,
  readLatestBusinessModel,
  writeBusinessModel,
} from './business-model-store';

let dir = '';
const scope = testProjectScope({ rootRealPath: '/repo' });
const otherProject = testProjectScope({ projectId: 'project-b', rootRealPath: '/repo-b' });
const otherInstall = testProjectScope({ installationId: 'install-b', rootRealPath: '/repo' });

const document: BusinessModelDocument = Object.freeze({
  schemaVersion: 1 as const,
  flows: Object.freeze([
    Object.freeze({
      fluxo: 'close_commanda',
      definicao: 'supabase/migrations/2.sql:10',
      escreve: Object.freeze(['appointments', 'commission_entries']),
      le: Object.freeze([]),
      funcoes: Object.freeze(['close_commanda']),
      arquivos: Object.freeze(['src/commanda.ts']),
      testes: Object.freeze(['tests/db/close-commanda.test.ts']),
    }),
  ]),
  invariants: Object.freeze([
    Object.freeze({
      id: 'close_commanda#1',
      fluxo: 'close_commanda',
      regra: 'close_commanda recusa: comanda ja fechada',
      origem: 'supabase/migrations/2.sql:14',
      arquivos: Object.freeze(['src/commanda.ts']),
      tabelas: Object.freeze(['appointments']),
      funcoes: Object.freeze(['close_commanda']),
      testes: Object.freeze(['tests/db/close-commanda.test.ts']),
    }),
  ]),
});

const hurdles = Object.freeze([
  Object.freeze({
    id: 'hurdle:abc123def456',
    titulo: 'deploy sexta derruba fila',
    resumo: 'migration antes do código',
    origem: 'docs/AGENTS-HURDLES.md:3',
  }),
]);

function write(headSha: string, over: Record<string, unknown> = {}) {
  return writeBusinessModel(scope, {
    headSha,
    fingerprint: 'fp',
    document,
    hurdles,
    ...over,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bm-store-'));
  configureBusinessModelStore(dir);
});

afterEach(() => {
  configureBusinessModelStore(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeBusinessModel + readBusinessModelAt', () => {
  it('round-trip: grava e lê o modelo por headSha', () => {
    const headSha = 'a'.repeat(40);
    const record = write(headSha);
    expect(record.headSha).toBe(headSha);
    const read = readBusinessModelAt(scope, headSha);
    expect(read).not.toBeNull();
    expect(read!.document.flows[0]!.fluxo).toBe('close_commanda');
    expect(read!.hurdles[0]!.titulo).toBe('deploy sexta derruba fila');
    expect(read!.fingerprint).toBe('fp');
  });

  it('o arquivo nasce com modo 0600 e sem temporário sobrando', () => {
    const headSha = 'b'.repeat(40);
    write(headSha);
    const files = fs.readdirSync(dir, { recursive: true }) as string[];
    const jsons = files.filter((name) => String(name).endsWith('.json'));
    expect(jsons).toHaveLength(1);
    expect(files.some((name) => String(name).endsWith('.tmp'))).toBe(false);
    const stat = fs.statSync(path.join(dir, jsons[0]!));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('isola por projeto e por instalação', () => {
    const headSha = 'c'.repeat(40);
    write(headSha);
    expect(readBusinessModelAt(otherProject, headSha)).toBeNull();
    expect(readBusinessModelAt(otherInstall, headSha)).toBeNull();
    expect(readBusinessModelAt(scope, 'd'.repeat(40))).toBeNull();
  });

  it('mesmo headSha regrava por cima (idempotente por commit)', () => {
    const headSha = 'e'.repeat(40);
    write(headSha, { fingerprint: 'fp-1' });
    write(headSha, { fingerprint: 'fp-2' });
    expect(readBusinessModelAt(scope, headSha)!.fingerprint).toBe('fp-2');
  });

  it('arquivo corrompido → null (nunca lança)', () => {
    const headSha = 'f'.repeat(40);
    write(headSha);
    const file = fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .find((name) => name.endsWith(`${headSha}.json`))!;
    fs.writeFileSync(path.join(dir, file), '{não é json');
    expect(readBusinessModelAt(scope, headSha)).toBeNull();
  });

  it('schema errado ou projeto de outro dono no payload → null', () => {
    const headSha = '0'.repeat(40);
    write(headSha);
    const file = fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .find((name) => name.endsWith(`${headSha}.json`))!;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...raw, schema: 'outro/v9' }));
    expect(readBusinessModelAt(scope, headSha)).toBeNull();
    fs.writeFileSync(
      path.join(dir, file),
      JSON.stringify({ ...raw, projectId: 'plantado-por-outro' }),
    );
    expect(readBusinessModelAt(scope, headSha)).toBeNull();
  });

  it('documento malformado dentro de um envelope válido → null', () => {
    const headSha = '1'.repeat(40);
    write(headSha);
    const file = fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .find((name) => name.endsWith(`${headSha}.json`))!;
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    fs.writeFileSync(
      path.join(dir, file),
      JSON.stringify({ ...raw, document: { schemaVersion: 1, flows: [{ fluxo: 1 }] } }),
    );
    expect(readBusinessModelAt(scope, headSha)).toBeNull();
  });

  it('headSha com formato inválido nem toca o disco', () => {
    expect(readBusinessModelAt(scope, '../etc/passwd')).toBeNull();
    expect(readBusinessModelAt(scope, 'não-hex')).toBeNull();
    expect(readBusinessModelAt(scope, '')).toBeNull();
  });

  it('headSha malicioso no write devolve o registro sem gravar arquivo fora do projeto', () => {
    const before = fs.readdirSync(dir, { recursive: true }).length;
    const record = write('../fugindo');
    expect(record.headSha).toBe('../fugindo');
    expect(fs.readdirSync(dir, { recursive: true }).length).toBe(before);
    expect(fs.existsSync(path.join(dir, 'fugindo.json'))).toBe(false);
  });
});

describe('readLatestBusinessModel', () => {
  it('devolve o mais recente gravado; sem store → null', () => {
    expect(readLatestBusinessModel(scope)).toBeNull();
    write('a'.repeat(40));
    const latest = readLatestBusinessModel(scope);
    expect(latest!.headSha).toBe('a'.repeat(40));
  });
});

describe('writeBusinessModel fail-open', () => {
  it('disco inacessível devolve o registro mesmo assim (memória segue)', () => {
    configureBusinessModelStore(path.join(dir, 'inexistente\0impossível'));
    const record = write('9'.repeat(40));
    expect(record.document.flows).toHaveLength(1);
    // E a leitura não explode.
    expect(readLatestBusinessModel(scope)).toBeNull();
  });
});

describe('configureBusinessModelStore', () => {
  it('isBusinessModelStoreConfigured reflete o configure', () => {
    configureBusinessModelStore(null);
    expect(isBusinessModelStoreConfigured()).toBe(false);
    configureBusinessModelStore(dir);
    expect(isBusinessModelStoreConfigured()).toBe(true);
  });
});
