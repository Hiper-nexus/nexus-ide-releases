import { expect, it } from 'vitest';
import { setKeySchema } from './provider-settings-types';

it.each(['auth:account', 'system:cron-authority-hmac:v1', 'agentkey:v1:a', '../claude', 'CLAUDE'])
('recusa nomes fora do namespace de adapters: %s', adapterId => {
  expect(setKeySchema.safeParse({ adapterId, key: 'key-test' }).success).toBe(false);
});
it.each(['claude', 'codex', 'my-custom-provider'])('aceita a sintaxe de id registrada: %s', adapterId => {
  expect(setKeySchema.safeParse({ adapterId, key: '' }).success).toBe(true);
});
