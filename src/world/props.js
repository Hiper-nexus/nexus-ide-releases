export const BARREL_RADIUS=.75,BARREL_RESPAWN=6,BARREL_SPEED=3,PROP_FRICTION=3.5,PROP_LIMIT=15,BLAST_RADIUS=6;
// ponytail: barris/props em círculo, sem colisão prop-prop; se precisar de empilhar, trocar por grade espacial.
const BARREL_SPOTS=[[3,-11],[-11,-11],[12,0],[-13,10],[2,13],[-4,-8]];

export function initialBarrels() {
  return BARREL_SPOTS.map(([x,z],id)=>({id,x,z,alive:true,respawn:0}));
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
