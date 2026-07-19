import Database from 'better-sqlite3';

let database;
try {
  database = new Database(':memory:');
  const result = database.prepare('select 1 as ok').get();
  if (result?.ok !== 1) throw new Error('SQLite health probe returned invalid data');
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Node native verification failed: ${detail}`);
  console.error(
    'Os nativos estão compilados para outra ABI (provavelmente Electron). ' +
      'Rode `npm run rebuild:node` antes de testar — nunca `npm rebuild`.',
  );
  process.exitCode = 1;
} finally {
  database?.close();
}
