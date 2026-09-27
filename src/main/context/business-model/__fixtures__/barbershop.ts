import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectExecutionScope } from '../../../../shared/types';
import { testProjectScope } from '../../../orch/__tests__/scope-fixture';
import { createContextAttestation, writeContextAttestation } from '../../context-attestation';
import { BUSINESS_MODEL_EXTRACTOR } from '../business-model-bootstrap';
import { BUSINESS_MODEL_TARGET_PATH } from '../business-model-contract';
import { extractBusinessModel } from '../business-model-extract';

/**
 * Projeto mínimo no formato do piloto (SaaS de barbearia): comanda fecha e
 * gera comissão numa RPC SQL, com trigger acoplado, regra no AGENTS.md,
 * chamador TS e teste de banco.
 */
export const BARBERSHOP_FILES: Readonly<Record<string, string>> = Object.freeze({
  'supabase/migrations/20260101000000_init.sql': [
    'create table public.appointments (',
    '  id uuid primary key,',
    "  status text not null check (status in ('open', 'closed')),",
    '  total numeric not null default 0',
    ');',
    '',
    'create table public.commission_entries (',
    '  id uuid primary key,',
    '  appointment_id uuid not null references public.appointments(id),',
    '  amount numeric not null check (amount >= 0),',
    '  unique (appointment_id)',
    ');',
    '',
    'create table public.commission_totals (barber_id uuid primary key, amount numeric not null);',
    '',
  ].join('\n'),
  'supabase/migrations/20260102000000_close_commanda.sql': [
    'create or replace function public.close_commanda(p_id uuid)',
    'returns void language plpgsql security definer as $$',
    'begin',
    "  if exists (select 1 from public.appointments where id = p_id and status = 'closed') then",
    "    raise exception 'comanda ja fechada: %', p_id;",
    '  end if;',
    "  update public.appointments set status = 'closed' where id = p_id;",
    '  insert into public.commission_entries (id, appointment_id, amount)',
    '    select gen_random_uuid(), p_id, total * 0.4 from public.appointments where id = p_id;',
    'end;',
    '$$;',
    '',
    'create or replace function public.sync_commission_totals()',
    'returns trigger language plpgsql as $fn$',
    'begin',
    '  update public.commission_totals set amount = amount + new.amount;',
    '  return new;',
    'end;',
    '$fn$;',
    '',
    'create trigger trg_commission_totals after insert on public.commission_entries',
    '  for each row execute function public.sync_commission_totals();',
    '',
  ].join('\n'),
  'AGENTS.md': [
    '# Regras',
    '',
    '- Nunca grave commission_entries fora de close_commanda.',
    '- Rode os testes de banco antes de subir migration.',
    '',
    '```sh',
    '- nunca isto é regra: está dentro de bloco de código',
    '```',
    '',
  ].join('\n'),
  'src/commanda.ts': [
    "import { supabase } from './db';",
    '',
    'export async function closeCommanda(id: string) {',
    "  return supabase.rpc('close_commanda', { p_id: id });",
    '}',
    '',
  ].join('\n'),
  'tests/db/close-commanda.test.ts': [
    "it('fecha a comanda e gera comissão', async () => {",
    "  await db.query('select public.close_commanda($1)', [id]);",
    '});',
    '',
  ].join('\n'),
  'package.json': '{ "name": "barbearia-fixture" }\n',
});

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function writeFixtureFile(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** Cria o repositório do fixture com tudo commitado. Quem chama remove `root`. */
export function createBarbershopRepo(
  files: Readonly<Record<string, string>> = BARBERSHOP_FILES,
): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-business-model-')));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [relative, content] of Object.entries(files)) writeFixtureFile(root, relative, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

/**
 * Grava o doc extraído com uma atestação real do extrator (o que o apply do
 * `.context` faria), para testes de consumidor do bloco/contrato.
 */
export async function applyAttestedBusinessModel(
  root: string,
  scope: ProjectExecutionScope = testProjectScope({ rootRealPath: root }),
): Promise<void> {
  const extraction = (await extractBusinessModel(root))!;
  const { content, sources } = extraction.proposal;
  writeFixtureFile(root, BUSINESS_MODEL_TARGET_PATH, content);
  writeContextAttestation(scope, createContextAttestation(scope, {
    targetPath: BUSINESS_MODEL_TARGET_PATH,
    targetHash: createHash('sha256').update(content).digest('hex'),
    sources,
    author: BUSINESS_MODEL_EXTRACTOR,
    reviewer: { id: 'nexus-business-model-reviewer', sessionId: 'deterministic-rederive-v1', provider: 'nexus-mechanical-review' },
    reviewedAt: new Date(0).toISOString(),
    nexusVersion: 'test',
  }));
}
