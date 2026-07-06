import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './index';

describe('health', () => {
  it('GET /health responde ok', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
