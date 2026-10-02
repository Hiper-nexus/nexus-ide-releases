import test from 'node:test';
import assert from 'node:assert/strict';
import { DESK, DEPLOY, CANARY, createDesk, resetDesk, sit, rise, deskStep, deployPlan, seatBlend, seatPose } from './desk.js';

const READY = deployPlan({ cooldown: 0, powered: 3, incident: null });
const DT = 1 / 60;

/** Avança a mesa por `seconds` com a mesma entrada e junta os eventos. */
function run(desk, seconds, input = {}) {
  const events = [];
  for (let t = 0; t < seconds - 1e-9; t += DT) desk = deskStep(desk, { dt: DT, plan: READY, ...input }, events);
  return { desk, events };
}

/** Sentado, com a tecla do sentar já solta. */
function seated() {
  let desk = run(sit(createDesk()), DESK.sitTime + 0.05).desk;
  desk = run(desk, 0.05, { holding: false }).desk;
  assert.equal(desk.phase, 'seated');
  return desk;
}

const count = (events, name) => events.filter(event => event === name).length;

test('de pé → sentando → sentado, com a pose indo de 0 a 1 sem voltar', () => {
  let desk = sit(createDesk());
  assert.equal(desk.phase, 'sitting');
  assert.equal(sit(desk), desk, 'sentar de novo não muda nada');
  const events = [];
  let last = 0;
  for (let t = 0; t < DESK.sitTime + 0.1; t += DT) {
    desk = deskStep(desk, { dt: DT, plan: READY }, events);
    const blend = seatBlend(desk);
    assert.ok(blend >= last - 1e-9, 'a pose só avança');
    last = blend;
  }
  assert.equal(desk.phase, 'seated');
  assert.equal(seatBlend(desk), 1);
  assert.deepEqual(events, ['seated']);
});

test('a tecla que sentou o dev não dispara um deploy: é preciso soltar e apertar de novo', () => {
  let desk = run(sit(createDesk()), DESK.sitTime + 0.05, { holding: true }).desk;
  const held = run(desk, 1, { holding: true });
  assert.equal(held.desk.phase, 'seated');
  assert.equal(count(held.events, 'start'), 0);
  desk = run(held.desk, 0.1, { holding: false }).desk;
  assert.equal(desk.phase, 'seated', 'soltar uma tecla que já vinha apertada não levanta');
  assert.equal(run(desk, 0.5, { holding: true }).desk.phase, 'acting');
});

test('segurar faz o deploy: linhas em ordem, teclas digitadas, XP uma vez e espera pelo próximo build', () => {
  const { desk, events } = run(seated(), DESK.runTime + DESK.tap + 0.2, { holding: true });
  assert.equal(desk.phase, 'done');
  assert.equal(desk.result, 'ok');
  assert.equal(desk.shown, DEPLOY.length);
  assert.equal(count(events, 'start'), 1);
  assert.equal(count(events, 'line'), DEPLOY.length);
  assert.equal(count(events, 'deployed'), 1);
  assert.ok(count(events, 'typing') > 20, 'as mãos digitam enquanto segura');
  assert.ok(desk.cooldown > DESK.cooldown - 0.5);
  // Segurando além do fim, nada se repete; o resultado fica na tela e volta a "sentado".
  const after = run(desk, DESK.resultTime + 0.5, { holding: true });
  assert.equal(count(after.events, 'deployed'), 0);
  assert.equal(after.desk.phase, 'seated');
  assert.equal(after.desk.shown, DEPLOY.length, 'o log continua no monitor');
});

test('soltar pausa o deploy sem perder o progresso', () => {
  const half = run(seated(), DESK.tap + DESK.runTime / 2, { holding: true }).desk;
  assert.equal(half.phase, 'acting');
  const paused = run(half, 2, { holding: false }).desk;
  assert.equal(paused.phase, 'acting');
  assert.equal(paused.progress, half.progress);
  const resumed = run(paused, DESK.tap + DESK.runTime / 2 + 0.2, { holding: true });
  assert.equal(resumed.desk.result, 'ok');
  assert.equal(count(resumed.events, 'start'), 0, 'continua o mesmo deploy');
});

test('um toque rápido levanta; andar ou Esc levantam a qualquer momento e abandonam o deploy', () => {
  let { desk, events } = run(seated(), DESK.tap / 2, { holding: true });
  ({ desk, events } = run(desk, DT, { holding: false }));
  assert.equal(desk.phase, 'rising');
  assert.deepEqual(events, ['rise']);
  const acting = run(seated(), DESK.tap + 1, { holding: true }).desk;
  for (const input of [{ moving: true }, { leave: true }]) {
    const out = run(acting, DT, input);
    assert.equal(out.desk.phase, 'rising');
    assert.equal(out.desk.progress, 0, 'deploy abandonado');
    assert.ok(out.events.includes('abort'));
  }
  const up = run(rise(acting), DESK.riseTime + 0.05);
  assert.equal(up.desk.phase, 'standing');
  assert.deepEqual(up.events, ['standing']);
  assert.equal(seatBlend(up.desk), 0);
});

test('sem rack no ar ou esperando o próximo build, segurar explica o motivo e não roda nada', () => {
  const none = deployPlan({ cooldown: 0, powered: 0, incident: null });
  assert.match(none.blocked, /rack/);
  const wait = deployPlan({ cooldown: 12.2, powered: 4, incident: null });
  assert.match(wait.blocked, /13 s/);
  assert.equal(READY.blocked, null);
  assert.equal(READY.fail, null);
  const { desk, events } = run(seated(), 2, { holding: true, plan: none });
  assert.equal(desk.phase, 'seated');
  assert.equal(count(events, 'blocked'), 1, 'avisa uma vez por aperto');
  assert.equal(count(events, 'start'), 0);
  assert.equal(run(desk, DT, { holding: false, plan: none }).desk.phase, 'seated', 'soltar depois de segurar não levanta');
});

test('com um incidente aberto o deploy cai no canary, sem XP e sem esperar build novo', () => {
  const plan = deployPlan({ cooldown: 0, powered: 3, incident: 'Claude' });
  assert.match(plan.fail, /Claude/);
  assert.equal(plan.blocked, null);
  const { desk, events } = run(seated(), DESK.tap + DESK.runTime + 1, { holding: true, plan });
  assert.equal(desk.result, 'failed');
  assert.equal(desk.failure, plan.fail);
  assert.equal(desk.shown, CANARY + 1, 'parou na linha do canary');
  assert.equal(count(events, 'failed'), 1);
  assert.equal(count(events, 'deployed'), 0);
  assert.equal(desk.cooldown, 0);
});

test('com redução de movimento sentar e levantar são imediatos', () => {
  const events = [];
  let desk = deskStep(sit(createDesk()), { dt: DT, plan: READY, calm: true }, events);
  assert.equal(desk.phase, 'seated');
  desk = deskStep(rise(desk), { dt: DT, plan: READY, calm: true }, events);
  assert.equal(desk.phase, 'standing');
  assert.deepEqual(events, ['seated', 'standing']);
});

test('a espera pelo próximo build corre mesmo com o dev de pé', () => {
  const desk = { ...createDesk(), cooldown: 5 };
  assert.ok(run(desk, 2).desk.cooldown < 3.1);
  const idle = createDesk();
  assert.equal(deskStep(idle, { dt: DT, plan: READY }, []), idle, 'nada mudou, mesmo objeto');
});

test('a pose leva o dev de onde estava até o assento, de frente para a mesa, e depois ao lugar de levantar', () => {
  const from = { x: 16.6, z: 12.4, heading: 0 }, seat = { x: 17.5, z: 11.28 }, stand = { x: 17.5, z: 12.42 };
  const start = seatPose(sit(createDesk()), from, seat, stand);
  assert.deepEqual([start.x, start.z, start.heading], [16.6, 12.4, 0]);
  const sitting = run(sit(createDesk()), DESK.sitTime + 0.05).desk;
  const there = seatPose(sitting, from, seat, stand);
  assert.ok(Math.abs(there.x - seat.x) < 1e-9 && Math.abs(there.z - seat.z) < 1e-9);
  assert.ok(Math.abs(Math.abs(there.heading) - Math.PI) < 1e-9, 'de costas para a câmera, olhando o monitor');
  const up = run(rise(sitting), DESK.riseTime + 0.05).desk;
  const rising = { ...rise(sitting), t: DESK.riseTime };
  const end = seatPose(rising, from, seat, stand);
  assert.ok(Math.abs(end.x - stand.x) < 1e-9 && Math.abs(end.z - stand.z) < 1e-9);
  assert.equal(up.phase, 'standing');
});

test('um toque curto com o deploy pausado levanta e não avança o deploy', () => {
  const half = run(seated(), DESK.tap + DESK.runTime / 2, { holding: true }).desk;
  const paused = run(half, 1, { holding: false }).desk;
  const tapping = run(paused, 0.1, { holding: true });
  assert.equal(tapping.desk.progress, paused.progress, 'um toque não digita nem avança');
  assert.equal(count(tapping.events, 'typing'), 0);
  const released = run(tapping.desk, DT, { holding: false });
  assert.deepEqual(released.events, ['abort', 'rise']);
  assert.equal(released.desk.phase, 'rising');
});

test('segurar além do toque retoma o deploy pausado de onde parou', () => {
  const half = run(seated(), DESK.tap + DESK.runTime / 2, { holding: true }).desk;
  const paused = run(half, 1, { holding: false }).desk;
  const resumed = run(paused, DESK.tap + 0.3, { holding: true }).desk;
  assert.equal(resumed.phase, 'acting');
  assert.ok(resumed.progress > paused.progress);
});

test('deploy em andamento é cancelado quando deixa de haver rack no ar: nada de XP sem data center', () => {
  const half = run(seated(), DESK.tap + DESK.runTime / 2, { holding: true }).desk;
  const empty = deployPlan({ cooldown: 0, powered: 0, incident: null });
  const after = run(half, DESK.runTime, { holding: true, plan: empty });
  assert.equal(count(after.events, 'deployed'), 0);
  assert.equal(count(after.events, 'abort'), 1);
  assert.equal(after.desk.phase, 'seated');
  assert.equal(after.desk.progress, 0);
  assert.equal(after.desk.deploys, 0);
});

test('recomeçar o progresso zera a mesa sem tirar o dev da cadeira', () => {
  const half = run(seated(), DESK.tap + DESK.runTime / 2, { holding: true }).desk;
  const fresh = resetDesk({ ...half, cooldown: 12, deploys: 3 });
  assert.deepEqual([fresh.phase, fresh.progress, fresh.cooldown, fresh.deploys, fresh.armed, fresh.result], ['seated', 0, 0, 0, false, null]);
  assert.deepEqual(resetDesk({ ...createDesk(), cooldown: 9, deploys: 2 }), createDesk());
  const rising = rise(seated());
  assert.equal(resetDesk({ ...rising, t: 0.2 }).phase, 'rising', 'no meio de levantar continua levantando');
});
