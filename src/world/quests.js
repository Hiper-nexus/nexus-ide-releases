const STATIONS = ['claude','codex','live'];
const COFFEE_COUNT = 5;
export function initialProgress() { return {stations:[],coffees:[],xp:0}; }

function normalize(stations, coffees) {
  const stationIds = [...new Set(stations)].filter(id=>STATIONS.includes(id));
  const coffeeIds = [...new Set(coffees)].filter(id=>Number.isInteger(id)&&id>=0&&id<COFFEE_COUNT);
  return {stations:stationIds,coffees:coffeeIds,xp:stationIds.length*100+coffeeIds.length*25};
}

export function advanceQuest(state, event) {
  return normalize(
    event.type==='station'?[...state.stations,event.id]:state.stations,
    event.type==='coffee'?[...state.coffees,event.id]:state.coffees,
  );
}

export function readProgress(raw) {
  try {
    const parsed=JSON.parse(raw);
    return normalize(Array.isArray(parsed?.stations)?parsed.stations:[],Array.isArray(parsed?.coffees)?parsed.coffees:[]);
  } catch { return initialProgress(); }
}

export function progressView(state) {
  const completed=state.stations.length+(state.coffees.length===COFFEE_COUNT?1:0);
  return {completed,complete:completed===4,level:state.xp>=400?3:state.xp>=150?2:1,title:state.xp>=400?'Builder':state.xp>=150?'Operador':'Explorador'};
}
