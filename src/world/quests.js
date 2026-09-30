const STATIONS = ['claude','codex','live'];
const COFFEE_COUNT = 5;
const BARREL_MISSION = 3;
export const XP_AWARD = {station:100,coffee:25,barrel:50};
export function initialProgress() { return {stations:[],coffees:[],barrels:0,xp:0}; }

function normalize(stations, coffees, barrels) {
  const stationIds = [...new Set(stations)].filter(id=>STATIONS.includes(id));
  const coffeeIds = [...new Set(coffees)].filter(id=>Number.isInteger(id)&&id>=0&&id<COFFEE_COUNT);
  const barrelCount = Number.isInteger(barrels)&&barrels>0?barrels:0;
  return {stations:stationIds,coffees:coffeeIds,barrels:barrelCount,
    xp:stationIds.length*XP_AWARD.station+coffeeIds.length*XP_AWARD.coffee+Math.min(barrelCount,BARREL_MISSION)*XP_AWARD.barrel};
}

export function advanceQuest(state, event) {
  return normalize(
    event.type==='station'?[...state.stations,event.id]:state.stations,
    event.type==='coffee'?[...state.coffees,event.id]:state.coffees,
    event.type==='barrel'?state.barrels+1:state.barrels,
  );
}

export function readProgress(raw) {
  try {
    const parsed=JSON.parse(raw);
    return normalize(Array.isArray(parsed?.stations)?parsed.stations:[],Array.isArray(parsed?.coffees)?parsed.coffees:[],parsed?.barrels);
  } catch { return initialProgress(); }
}

export function progressView(state) {
  const completed=state.stations.length+(state.coffees.length===COFFEE_COUNT?1:0)+(state.barrels>=BARREL_MISSION?1:0);
  const total=STATIONS.length+2;
  return {completed,complete:completed===total,level:state.xp>=400?3:state.xp>=150?2:1,title:state.xp>=400?'Builder':state.xp>=150?'Operador':'Explorador'};
}
