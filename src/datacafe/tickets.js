/** Tickets do NOC e progresso do jogador. Puro: o telão e o HUD só leem. */
import { ENERGY } from './energy.js';
import { incidentIds, allPowered, installedIds } from './racks.js';

export const TICKET_XP = { incident: 40, coffee: 10, install: 60 };

export const LEVEL_TITLES = ['Estagiário', 'Júnior', 'Pleno', 'Sênior', 'Staff', 'Principal'];

export const BADGES = {
  'primeira-gpu': 'Primeira GPU instalada',
  'apagou-incendio': 'Primeiro incidente resolvido',
  'metade-no-ar': 'Metade do data center no ar',
  'data-center-completo': 'Data center completo: as 18 LLMs no ar',
};

function nameOf(models, id) {
  return models.find(model => model.id === id)?.name ?? id;
}

/** Os tickets do momento, por prioridade: incidentes, café baixo e depois instalações. */
export function ticketsFrom(rackState, energy, models) {
  const tickets = incidentIds(rackState).map(id => ({
    id: `incident:${id}`, kind: 'incident', rackId: id, xp: TICKET_XP.incident,
    title: `${nameOf(models, id)} caiu: reinicie o rack`,
  }));
  if (energy.value < ENERGY.low) {
    tickets.push({ id: 'coffee', kind: 'coffee', xp: TICKET_XP.coffee, title: 'Café acabando: passe na cafeteira' });
  }
  for (const id of rackState.order) {
    if (rackState.racks[id].state !== 'off') continue;
    tickets.push({ id: `install:${id}`, kind: 'install', rackId: id, xp: TICKET_XP.install, title: `Instale uma GPU no rack ${nameOf(models, id)}` });
  }
  return tickets;
}

/** Curva suave: nível 2 em 100 XP, 3 em 400, 4 em 900, 5 em 1600. */
export function levelFor(xp) {
  return Math.min(LEVEL_TITLES.length, Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1);
}

export function titleFor(level) {
  return LEVEL_TITLES[Math.max(0, Math.min(LEVEL_TITLES.length - 1, level - 1))];
}

/** XP de 0 a 1 dentro do nível atual, para a barra do HUD. */
export function levelProgress(xp) {
  const level = levelFor(xp);
  if (level >= LEVEL_TITLES.length) return 1;
  const floor = 100 * (level - 1) ** 2, ceil = 100 * level ** 2;
  return (xp - floor) / (ceil - floor);
}

export function completeTicket(progress, ticket) {
  const xpGained = Math.max(0, ticket?.xp ?? 0);
  const xp = progress.xp + xpGained;
  const level = levelFor(xp);
  return {
    progress: { ...progress, xp, level, completed: progress.completed + 1, incidents: progress.incidents + (ticket?.kind === 'incident' ? 1 : 0) },
    xpGained,
    leveledUp: level > progress.level,
  };
}

/** Selos conquistados, sem nunca perder um que já existia. */
export function badgesFor(progress, rackState) {
  const earned = new Set(progress.badges);
  const installed = installedIds(rackState).length;
  if (installed >= 1) earned.add('primeira-gpu');
  if (progress.incidents >= 1) earned.add('apagou-incendio');
  if (installed >= rackState.order.length / 2) earned.add('metade-no-ar');
  if (allPowered(rackState)) earned.add('data-center-completo');
  return Object.keys(BADGES).filter(badge => earned.has(badge));
}
