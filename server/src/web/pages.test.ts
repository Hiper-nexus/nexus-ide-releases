import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildWebPages } from './pages';

describe('páginas web mínimas', () => {
  const app = express().use(buildWebPages());

  it('success/cancel/join respondem HTML com instrução de voltar ao app', async () => {
    const success = await request(app).get('/billing/success');
    expect(success.status).toBe(200);
    expect(success.text).toContain('NexusIDE');

    expect((await request(app).get('/billing/cancel')).status).toBe(200);

    const join = await request(app).get('/join/AB12-CD34');
    expect(join.status).toBe(200);
    expect(join.text).toContain('AB12-CD34');

    const evil = await request(app).get('/join/<script>x</script>');
    expect(evil.status).toBe(200);
    expect(evil.text).not.toContain('<script>x');
  });
});
