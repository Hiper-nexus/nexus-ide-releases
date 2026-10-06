import test from 'node:test';
import assert from 'node:assert/strict';
import { activityView } from './activity.js';
const sample = { onlineNow: 2, usedToday: 1, used7d: 2, startedAgents: 3, completedMission: 1, returned: 1, paidAccounts: 0, trackedAccounts: 4, measuringSince: '2026-10-05T15:00:00.000Z' };
test('presence, real use and paid subscriptions are separate, valid counts', () => {
  const view = activityView(sample);
  assert.equal(view.metrics.find(row => row.key === 'paidAccounts').value, 0);
  assert.equal(view.metrics.find(row => row.key === 'onlineNow').value, 2);
  assert.match(view.note, /não.*login/i);
  assert.match(view.note, /05\/10\/2026/);
});
test('missing or malformed measurements are unavailable, not fabricated zeroes', () => {
  for (const value of [null, {}, { ...sample, onlineNow: -1 }, { ...sample, usedToday: 0.5 }, { ...sample, measuringSince: 'ontem' }]) assert.equal(activityView(value), null);
  assert.match(activityView({ ...sample, measuringSince: null }).note, /ainda não/i);
});
