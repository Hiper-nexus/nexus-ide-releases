import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { prepareCached } from './scoped-store';

it('prepares a hot query once per connection, retaining parameter binding and fresh rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)');
    const spy = vi.spyOn(db, 'prepare');
    const sql = 'SELECT value FROM test WHERE id = ?';
    expect(prepareCached(db, sql).get(1)).toBeUndefined();
    db.exec("INSERT INTO test VALUES (1, 'fresh')");
    expect(prepareCached(db, sql).get(1)).toEqual({ value: 'fresh' });
    expect(prepareCached(db, sql).get(2)).toBeUndefined();
    expect(spy.mock.calls.filter(([query]) => query === sql)).toHaveLength(1);
  } finally { db.close(); }
});

it('never reuses a statement after a connection closes and reopens', () => {
  const first = new Database(':memory:');
  const statement = prepareCached(first, 'SELECT 1');
  first.close();
  const second = new Database(':memory:');
  try { expect(prepareCached(second, 'SELECT 1')).not.toBe(statement); }
  finally { second.close(); }
});

it('bounds the cache for dynamic IN clauses and evicts old statements', () => {
  const db = new Database(':memory:');
  try {
    const first = prepareCached(db, 'SELECT 0');
    for (let i = 1; i <= 128; i++) prepareCached(db, `SELECT ${i}`);
    expect(prepareCached(db, 'SELECT 0')).not.toBe(first);
  } finally { db.close(); }
});
