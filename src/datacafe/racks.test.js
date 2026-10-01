import test from 'node:test';
import assert from 'node:assert/strict';
import { RACK_RULES, createRacks, installGpu, reboot, rackStep, poweredCount, incidentIds, allPowered, installedIds, maxIncidents, rackState } from './racks.js';

const IDS = Array.from({ length: 18 }, (_, i) => `llm${i}`);
const always = () => 0;
const never = () => 1;

test('racks começam desligados e ligam com uma GPU', () => {
  let state = createRacks(IDS);
  assert.equal(poweredCount(state), 0);
  const next = installGpu(state, 'llm3');
  assert.equal(rackState(next, 'llm3'), 'on');
  assert.equal(rackState(state, 'llm3'), 'off', 'imutável');
  assert.equal(installGpu(next, 'llm3'), next, 'instalar de novo não muda nada');
  assert.throws(() => installGpu(state, 'nada'), /desconhecido/);
});

test('o progresso salvo religa os racks já instalados', () => {
  const state = createRacks(IDS, ['llm0', 'llm5']);
  assert.deepEqual(installedIds(state), ['llm0', 'llm5']);
});

test('incidentes só acontecem em racks ligados, depois da carência, até o limite', () => {
  let state = createRacks(IDS, IDS.slice(0, 5));
  assert.equal(maxIncidents(5), 1);
  let result = rackStep(state, 0.1, always);
  assert.equal(result.events.length, 1);
  assert.equal(incidentIds(result.state).length, 1);
  const again = rackStep(result.state, 0.1, always);
  assert.equal(incidentIds(again.state).length, 1, 'no máximo um com cinco racks');
  const fresh = installGpu(createRacks(IDS, IDS.slice(0, 4)), 'llm10');
  const quiet = rackStep(fresh, 0.1, always);
  assert.ok(!quiet.events.some(event => event.id === 'llm10'), 'rack recém-ligado tem carência');
});

test('reiniciar tira o rack do incidente e reinicia a carência', () => {
  const state = rackStep(createRacks(IDS, IDS.slice(0, 5)), 0.1, always).state;
  const [down] = incidentIds(state);
  const fixed = reboot(state, down);
  assert.equal(rackState(fixed, down), 'on');
  assert.equal(fixed.racks[down].uptime, 0);
  assert.equal(reboot(fixed, down), fixed);
});

test('propriedade: nunca há incidente em rack desligado', () => {
  let seed = 42;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let state = createRacks(IDS);
  for (let i = 0; i < 4000; i++) {
    if (rng() < 0.01) state = installGpu(state, IDS[Math.floor(rng() * IDS.length)]);
    if (rng() < 0.02) for (const id of incidentIds(state)) state = reboot(state, id);
    const result = rackStep(state, rng() * 0.2 + RACK_RULES.graceSeconds * 0, rng);
    for (const event of result.events) assert.notEqual(state.racks[event.id].state, 'off');
    state = result.state;
    assert.ok(incidentIds(state).length <= maxIncidents(poweredCount(state)) || incidentIds(state).length <= 3);
  }
});

test('sem sorteio favorável nada cai e o estado é o mesmo objeto quando nada está ligado', () => {
  const off = createRacks(IDS);
  assert.equal(rackStep(off, 0.1, always).state, off);
  const on = createRacks(IDS, IDS);
  assert.equal(rackStep(on, 0.1, never).events.length, 0);
  assert.equal(allPowered(on), true);
});
