import { WORLD } from './layout.js';
export const BARREL_RADIUS=.75,BARREL_RESPAWN=6,BARREL_SPEED=3,PROP_FRICTION=3.5,PROP_LIMIT=WORLD.limit,BLAST_RADIUS=6;
// ponytail: barris/props em círculo, sem colisão prop-prop; se precisar de empilhar, trocar por grade espacial.
// ponytail: os barris ficam fora das caixas de colisão (OBSTACLES em layout.js), senão o rover nunca alcança.
export function initialBarrels(spots=WORLD.barrels) {
  return spots.map(([x,z],id)=>({id,x,z,alive:true,respawn:0}));
}

export function hitBarrel(vehicle,barrels,minSpeed=BARREL_SPEED) {
  const speed=Math.hypot(vehicle.vx??0,vehicle.vz??0);
  if(speed<minSpeed)return null;
  const hit=barrels.find(barrel=>barrel.alive&&Math.hypot(vehicle.x-barrel.x,vehicle.z-barrel.z)<BARREL_RADIUS);
  return hit?hit.id:null;
}

export function detonateBarrel(barrels,id) {
  return barrels.map(barrel=>barrel.id===id?{...barrel,alive:false,respawn:BARREL_RESPAWN}:barrel);
}

export function stepBarrels(barrels,delta) {
  const dt=Math.max(0,delta);
  if(barrels.every(barrel=>barrel.alive))return barrels;
  return barrels.map(barrel=>{
    if(barrel.alive||barrel.respawn<=0)return barrel.alive?barrel:{...barrel,respawn:0,alive:true};
    const respawn=barrel.respawn-dt;
    return respawn<=0?{...barrel,alive:true,respawn:0}:{...barrel,respawn};
  });
}

export function pushProp(prop,fromX,fromZ,force) {
  let dx=prop.x-fromX,dz=prop.z-fromZ;
  const distance=Math.hypot(dx,dz);
  if(!distance){dx=0;dz=1;}
  else{dx/=distance;dz/=distance;}
  return {...prop,vx:prop.vx+dx*force,vz:prop.vz+dz*force};
}

export function stepProps(props,delta) {
  const dt=Math.max(0,Math.min(delta,.1));
  const decay=Math.exp(-PROP_FRICTION*dt);
  const clamp=value=>Math.max(-PROP_LIMIT,Math.min(PROP_LIMIT,value));
  // At rest nothing changes: hand back the same array so the frame loop allocates nothing.
  if(props.every(prop=>prop.vx===0&&prop.vz===0))return props;
  return props.map(prop=>{
    const vx=prop.vx*decay,vz=prop.vz*decay;
    const still=Math.abs(vx)<.02&&Math.abs(vz)<.02;
    return {...prop,vx:still?0:vx,vz:still?0:vz,x:still?prop.x:clamp(prop.x+vx*dt),z:still?prop.z:clamp(prop.z+vz*dt)};
  });
}

export function blastImpulse(vehicle,barrel,power) {
  const dx=vehicle.x-barrel.x,dz=vehicle.z-barrel.z;
  const distance=Math.hypot(dx,dz);
  if(distance>=BLAST_RADIUS)return {vx:0,vz:0};
  const magnitude=power*(1-distance/BLAST_RADIUS);
  return distance?{vx:dx/distance*magnitude,vz:dz/distance*magnitude}:{vx:power,vz:0};
}

/** Crates shatter when the rover hits them hard enough. Returns the ids that broke this frame. */
export function breakCrates(props,minSpeed=4.5) {
  const broke=[];
  for(const prop of props){
    if(prop.kind!=='crate'||prop.broken)continue;
    if(Math.hypot(prop.vx,prop.vz)>=minSpeed)broke.push(prop.id);
  }
  return broke;
}

/** Marks those crates as gone; the scene hides the meshes. */
export function shatterCrates(props,ids) {
  if(!ids.length)return props;
  const gone=new Set(ids);
  return props.map(prop=>gone.has(prop.id)?{...prop,broken:true,vx:0,vz:0}:prop);
}
