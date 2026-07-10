import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { databasePoolTimeoutsFrom, makeDb } from './client';
import { parseEnv } from '../env';

const env = parseEnv(process.env);
const { db, pool } = makeDb(
  env.DATABASE_URL,
  databasePoolTimeoutsFrom(env),
);
await migrate(db, { migrationsFolder: 'drizzle' });
await pool.end();
console.log('[migrate] ok');
