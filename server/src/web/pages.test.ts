import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildWebPages } from './pages';

describe('páginas web mínimas', () => {
  const app = express().use(buildWebPages());
  const server = createServer(app);

  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );

  it('success/cancel/join respondem HTML com instrução de voltar ao app', async () => {
    const success = await request(server).get('/billing/success');
    expect(success.status).toBe(200);
    expect(success.text).toContain('NexusIDE');

    expect((await request(server).get('/billing/cancel')).status).toBe(200);

    const join = await request(server).get('/join/AB12-CD34');
    expect(join.status).toBe(200);
    expect(join.text).toContain('AB12-CD34');

    const evil = await request(server).get('/join/<script>x</script>');
    expect(evil.status).toBe(200);
    expect(evil.text).not.toContain('<script>x');
  });
});
