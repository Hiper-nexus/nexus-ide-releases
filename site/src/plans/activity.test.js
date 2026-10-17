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
  assert.match(view.note, /1\/1/);
  assert.equal(view.metrics.find(row => row.key === 'completedMission').hint, 'já concluíram ao menos uma missão');
  assert.match(view.note, /atividade de missão/i);
});
test('missing or malformed measurements are unavailable, not fabricated zeroes', () => {
  for (const value of [null, {}, { ...sample, onlineNow: -1 }, { ...sample, usedToday: 0.5 }, { ...sample, measuringSince: 'ontem' }]) assert.equal(activityView(value), null);
  assert.match(activityView({ ...sample, measuringSince: null }).note, /ainda não/i);
});

const funnel = { totalTrial: 8, loggedIn: 8, openedApp: 6, usedSystem: 4, ranMissions: 2, activeToday: 1, active7d: 3, onlineNow: 1 };
test('missões rodando e concluídas entram nas métricas; ausentes ficam sem valor, não zero', () => {
  const view = activityView({ ...sample, missionsTotalCompleted: 12, missionsRunningNow: 2 });
  assert.equal(view.metrics.find(row => row.key === 'missionsRunningNow').value, 2);
  assert.equal(view.metrics.find(row => row.key === 'missionsTotalCompleted').value, 12);
  const legacy = activityView(sample);
  assert.equal(legacy.metrics.find(row => row.key === 'missionsRunningNow').value, null);
  assert.equal(legacy.funnel, null);
  for (const bad of [{ missionsRunningNow: -1 }, { missionsTotalCompleted: 1.5 }, { missionsRunningNow: '2' }]) assert.equal(activityView({ ...sample, ...bad }), null);
});

test('o funil de teste é proporcional a totalTrial e só vale com o contrato inteiro', () => {
  const view = activityView({ ...sample, trialFunnel: funnel }).funnel;
  assert.equal(view.total, 8);
  assert.deepEqual(view.steps.map(step => [step.key, step.value, step.percent]), [
    ['totalTrial', 8, 100], ['loggedIn', 8, 100], ['openedApp', 6, 75], ['usedSystem', 4, 50], ['ranMissions', 2, 25], ['active7d', 3, 38],
  ]);
  assert.equal(view.steps[2].ratio, 0.75);
  assert.equal(view.live, '1 online agora, 1 usaram hoje');
  assert.equal(activityView({ ...sample, trialFunnel: { ...funnel, totalTrial: 0, loggedIn: 0, openedApp: 0, usedSystem: 0, ranMissions: 0, active7d: 0 } }).funnel.steps[1].percent, 0);
  for (const bad of [null, {}, { ...funnel, openedApp: -1 }, { ...funnel, onlineNow: undefined }, 'x']) assert.equal(activityView({ ...sample, trialFunnel: bad }).funnel, null);
});
