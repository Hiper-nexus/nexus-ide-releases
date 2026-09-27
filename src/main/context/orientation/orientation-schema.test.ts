import { describe, expect, it } from 'vitest';
import {
  dbNodeId,
  extractSchemaEntitiesFromDrizzle,
  extractSchemaEntitiesFromPrisma,
  extractSchemaEntitiesFromSql,
  sortSchemaPathsByTimestamp,
} from './orientation-schema';

describe('orientation-schema: SQL schema detectors', () => {
  it('detects CREATE TABLE with and without an explicit schema', () => {
    const facts = extractSchemaEntitiesFromSql(
      'supabase/migrations/20260101000000_init.sql',
      `
        CREATE TABLE IF NOT EXISTS public.appointments (id uuid primary key);
        CREATE TABLE commission_entries (id uuid primary key);
      `,
    );
    const names = facts.map((f) => f.qualifiedName).sort();
    expect(names).toEqual(['public.appointments', 'public.commission_entries']);
    expect(facts.every((f) => f.kind === 'table')).toBe(true);
  });

  it('marks RLS enabled on a table via ALTER TABLE ... ENABLE ROW LEVEL SECURITY', () => {
    const facts = extractSchemaEntitiesFromSql(
      'supabase/migrations/20260101000001_rls.sql',
      `
        CREATE TABLE public.appointments (id uuid primary key);
        ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
      `,
    );
    const appointments = facts.find((f) => f.qualifiedName === 'public.appointments');
    expect(appointments?.rlsEnabled).toBe(true);
  });

  it('recognizes CREATE POLICY ... ON table as a reference to that table without breaking parsing', () => {
    const facts = extractSchemaEntitiesFromSql(
      'supabase/migrations/20260101000002_policy.sql',
      `CREATE POLICY tenant_isolation ON public.appointments USING (tenant_id = auth.uid());`,
    );
    expect(facts.map((f) => f.qualifiedName)).toEqual(['public.appointments']);
  });

  it('detects CREATE FUNCTION as a function node', () => {
    const facts = extractSchemaEntitiesFromSql(
      'supabase/migrations/20260101000003_fn.sql',
      `CREATE OR REPLACE FUNCTION public.close_commanda_internal(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$;`,
    );
    expect(facts).toEqual([
      expect.objectContaining({
        kind: 'function',
        qualifiedName: 'public.close_commanda_internal',
        name: 'close_commanda_internal',
      }),
    ]);
  });

  it('builds a stable prefixed node id per kind', () => {
    expect(dbNodeId('table', 'public.comandas')).toBe('db:table:public.comandas');
    expect(dbNodeId('function', 'public.close_commanda_internal')).toBe(
      'db:function:public.close_commanda_internal',
    );
  });
});

describe('orientation-schema: Prisma and Drizzle detectors', () => {
  it('maps a prisma model to its @@map table name when present', () => {
    const facts = extractSchemaEntitiesFromPrisma(
      'prisma/schema.prisma',
      `
        model Commission {
          id String @id
          @@map("commission_entries")
        }
        model Appointment {
          id String @id
        }
      `,
    );
    const names = facts.map((f) => f.qualifiedName).sort();
    expect(names).toEqual(['public.Appointment', 'public.commission_entries']);
  });

  it('detects drizzle pgTable(...) schema declarations', () => {
    const facts = extractSchemaEntitiesFromDrizzle(
      'src/db/schema.ts',
      `export const commissionEntries = pgTable('commission_entries', { id: uuid('id') });`,
    );
    expect(facts.map((f) => f.qualifiedName)).toEqual(['public.commission_entries']);
  });
});

describe('orientation-schema: migration ordering', () => {
  it('sorts timestamp-prefixed migrations ascending, ahead of untimestamped files', () => {
    const sorted = sortSchemaPathsByTimestamp([
      'supabase/migrations/20260701120000_settle_commissions.sql',
      'supabase/migrations/20260101000000_init.sql',
      'supabase/seed.sql',
      'supabase/migrations/20260612190000_resolve_commission_info.sql',
    ]);
    expect(sorted).toEqual([
      'supabase/migrations/20260101000000_init.sql',
      'supabase/migrations/20260612190000_resolve_commission_info.sql',
      'supabase/migrations/20260701120000_settle_commissions.sql',
      'supabase/seed.sql',
    ]);
  });
});
