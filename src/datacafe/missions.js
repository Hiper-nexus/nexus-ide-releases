/** Missões do turno: até três objetivos ativos, cada um com recompensa em XP.
 * Ao fechar uma, a vaga recebe a próxima do baralho. Puro e imutável.
 * `kind` é o tipo de evento que avança a missão: o tipo do ticket concluído
 * ('install', 'incident', 'coffee') ou 'combo', que guarda a maior sequência. */
export const MISSIONS = [
  { id: 'ligar-3', text: 'Ligue 3 racks', kind: 'install', goal: 3, xp: 80 },
  { id: 'bombeiro-2', text: 'Resolva 2 incidentes', kind: 'incident', goal: 2, xp: 100 },
  { id: 'combo-3', text: 'Chegue ao combo ×3', kind: 'combo', goal: 3, xp: 90 },
  { id: 'cafe-em-dia', text: 'Tome café antes de cansar', kind: 'coffee', goal: 1, xp: 40 },
  { id: 'ligar-5', text: 'Ligue 5 racks', kind: 'install', goal: 5, xp: 140 },
  { id: 'bombeiro-4', text: 'Resolva 4 incidentes', kind: 'incident', goal: 4, xp: 180 },
  { id: 'combo-5', text: 'Chegue ao combo ×5', kind: 'combo', goal: 5, xp: 160 },
];
export const MISSION_SLOTS = 3;

/** Próxima missão do baralho a partir de `from` que não esteja ativa, proibida nem indisponível. */
function draw(pool, from, taken, unavailable) {
  for (let i = 0; i < pool.length; i++) {
    const index = (from + i) % pool.length;
    const mission = pool[index];
    if (taken.has(mission.id) || unavailable.includes(mission.kind)) continue;
    return { mission, next: index + 1 };
  }
  return null;
}

export function createMissions(pool = MISSIONS, slots = MISSION_SLOTS, unavailable = []) {
  const active = [];
  let next = 0;
  while (active.length < slots) {
    const drawn = draw(pool, next, new Set(active.map(mission => mission.id)), unavailable);
    if (!drawn) break;
    active.push({ id: drawn.mission.id, done: 0 });
    next = drawn.next;
  }
  return { active, next, completed: 0 };
}

/** Aplica um evento. Devolve o mesmo estado quando nada mudou. */
export function missionEvent(state, event, pool = MISSIONS, unavailable = []) {
  const finished = [];
  let next = state.next;
  let changed = false;
  const active = [];
  for (const entry of state.active) {
    const mission = pool.find(item => item.id === entry.id);
    if (!mission || mission.kind !== event.kind) { active.push(entry); continue; }
    const done = mission.kind === 'combo' ? Math.max(entry.done, event.value ?? 0) : entry.done + 1;
    if (done === entry.done) { active.push(entry); continue; }
    changed = true;
    if (done < mission.goal) { active.push({ id: entry.id, done }); continue; }
    finished.push(mission);
    active.push(null);
  }
  if (!changed) return { state, finished };
  // As vagas abertas recebem a próxima do baralho; a que acabou de fechar não volta na mesma rodada.
  const taken = new Set([...active.filter(Boolean).map(entry => entry.id), ...finished.map(mission => mission.id)]);
  const refilled = [];
  for (const entry of active) {
    if (entry) { refilled.push(entry); continue; }
    const drawn = draw(pool, next, taken, unavailable);
    if (!drawn) continue;
    taken.add(drawn.mission.id);
    next = drawn.next;
    refilled.push({ id: drawn.mission.id, done: 0 });
  }
  return { state: { active: refilled, next, completed: state.completed + finished.length }, finished };
}

/** Tira da lista as missões que ficaram impossíveis (ex.: instalar com o data center completo). */
export function dropUnavailable(state, pool = MISSIONS, unavailable = []) {
  const active = state.active.filter(entry => !unavailable.includes(pool.find(item => item.id === entry.id)?.kind));
  return active.length === state.active.length ? state : { ...state, active };
}

/** Lista para o HUD: texto, progresso e recompensa. */
export function missionView(state, pool = MISSIONS) {
  return state.active.map(entry => {
    const mission = pool.find(item => item.id === entry.id);
    return { id: entry.id, text: mission.text, done: Math.min(entry.done, mission.goal), goal: mission.goal, xp: mission.xp };
  });
}
