import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export function makeDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
