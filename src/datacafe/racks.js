/** Estado dos 18 racks, um por LLM. Puro e imutável. 'off' espera uma GPU,
 * 'on' está no ar e 'incident' caiu e precisa de reinício. */
export const RACK_RULES = {
  /** Chance por segundo de cada rack ligado cair. */
  incidentRate: 0.012,
  /** Um rack recém-ligado fica este tempo sem cair. */
  graceSeconds: 12,
};

/** Quantos incidentes simultâneos o data center aguenta cresce com o tamanho dele. */
export function maxIncidents(powered) {
  if (powered < 3) return 0;
  if (powered < 8) return 1;
  if (powered < 14) return 2;
  return 3;
}

export function createRacks(ids, installed = []) {
  const on = new Set(installed);
  return {
    order: [...ids],
    racks: Object.fromEntries(ids.map(id => [id, { state: on.has(id) ? 'on' : 'off', uptime: RACK_RULES.graceSeconds }])),
  };
}

function assertKnown(state, id) {
  if (!state.racks[id]) throw new Error(`rack desconhecido: ${id}`);
}

function withRack(state, id, rack) {
  return { ...state, racks: { ...state.racks, [id]: rack } };
}

export function installGpu(state, id) {
  assertKnown(state, id);
  if (state.racks[id].state !== 'off') return state;
  return withRack(state, id, { state: 'on', uptime: 0 });
}

export function reboot(state, id) {
  assertKnown(state, id);
  if (state.racks[id].state !== 'incident') return state;
  return withRack(state, id, { state: 'on', uptime: 0 });
}

export function rackState(state, id) {
  return state.racks[id]?.state ?? null;
}

export function poweredCount(state) {
  return state.order.filter(id => state.racks[id].state !== 'off').length;
}

export function incidentIds(state) {
  return state.order.filter(id => state.racks[id].state === 'incident');
}

export function installedIds(state) {
  return state.order.filter(id => state.racks[id].state !== 'off');
}

/** Todas as GPUs instaladas, mesmo que algum rack esteja em incidente agora. */
export function allPowered(state) {
  return state.order.every(id => state.racks[id].state !== 'off');
}

/** Avança o relógio dos racks ligados e sorteia incidentes. `rng` é injetável para testes. */
export function rackStep(state, dt, rng = Math.random) {
  const step = Math.max(0, Math.min(dt, 0.25));
  const events = [];
  let racks = null;
  let incidents = incidentIds(state).length;
  const limit = maxIncidents(poweredCount(state));
  for (const id of state.order) {
    const rack = state.racks[id];
    if (rack.state !== 'on') continue;
    let next = { state: 'on', uptime: rack.uptime + step };
    if (incidents < limit && next.uptime >= RACK_RULES.graceSeconds && rng() < RACK_RULES.incidentRate * step) {
      next = { state: 'incident', uptime: 0 };
      incidents += 1;
      events.push({ type: 'incident', id });
    }
    racks ??= { ...state.racks };
    racks[id] = next;
  }
  return { state: racks ? { ...state, racks } : state, events };
}
