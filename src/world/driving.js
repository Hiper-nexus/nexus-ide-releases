import { WORLD } from './layout.js';

const ACCELERATION=16,BRAKE=12,DRAG=4,MAX_SPEED=8,MAX_REVERSE=4,BOOST_SPEED=12.5,BOOST_ACCEL=8,PAD_MAX=15,PAD_BURST=5,OVERSPEED_DECAY=6,
STEERING=2.6,STEER_SPEED=10,GRIP=10,DRIFT_GRIP=1.6,HANDBRAKE_STEER=1.5,HANDBRAKE_DRAG=.25,AIR_STEER=.3,GRAVITY=22,
BOOST_DRAIN=.45,BOOST_REGEN=.18,LIMIT=WORLD.limit,ROVER_RADIUS=.55;
const NO_TERRAIN={ramps:[],boostPads:[]};
export function initialVehicle() {return {x:WORLD.spawn.x,z:WORLD.spawn.z,heading:WORLD.spawn.heading,vx:0,vz:0,steer:0,boostCharge:1,y:0,vy:0,onPad:false};}

function seeded(state) {
  const base={y:0,vy:0,onPad:false,...state};
  if(state.vx!=null&&state.vz!=null)return base;
  const speed=state.speed||0;
  return {...base,vx:-Math.sin(state.heading)*speed,vz:-Math.cos(state.heading)*speed};
}

function collides(x,z,obstacles) {
  return obstacles.some(obstacle=>Math.abs(x-obstacle.x)<obstacle.width/2+ROVER_RADIUS && Math.abs(z-obstacle.z)<obstacle.depth/2+ROVER_RADIUS);
}

/** Position of a point in a feature's own frame: `along` grows toward its heading, from its start edge. */
function local(feature,x,z) {
  const fx=-Math.sin(feature.heading),fz=-Math.cos(feature.heading);
  const dx=x-feature.x,dz=z-feature.z;
  return {along:dx*fx+dz*fz+feature.length/2,across:dx*Math.cos(feature.heading)-dz*Math.sin(feature.heading)};
}
const covers=(feature,x,z)=>{const p=local(feature,x,z);return Math.abs(p.across)<feature.width/2&&p.along>=0&&p.along<=feature.length;};

/** Height of the ground under a point: ramps rise from 0 to their height along their length. */
export function groundHeight(x,z,ramps=[]) {
  for(const ramp of ramps){const p=local(ramp,x,z);if(Math.abs(p.across)<ramp.width/2&&p.along>=0&&p.along<=ramp.length)return p.along/ramp.length*ramp.height;}
  return 0;
}

export function drive(rawState,input,delta,obstacles,terrain=NO_TERRAIN) {
  const state=seeded(rawState);
  const dt=Math.max(0,Math.min(delta,.1));
  const groundBefore=groundHeight(state.x,state.z,terrain.ramps);
  const airborne=state.y>groundBefore+.02;
  const maxStep=STEER_SPEED*dt;
  const steer=state.steer+Math.max(-maxStep,Math.min(maxStep,input.steer-state.steer));
  const useBoost=input.boost&&state.boostCharge>0&&!airborne;
  const boostCharge=useBoost?Math.max(0,state.boostCharge-BOOST_DRAIN*dt):Math.min(1,state.boostCharge+BOOST_REGEN*dt);
  const fx=-Math.sin(state.heading),fz=-Math.cos(state.heading),rx=Math.cos(state.heading),rz=-Math.sin(state.heading);
  let forward=state.vx*fx+state.vz*fz;
  let lateral=state.vx*rx+state.vz*rz;
  const before=Math.abs(forward);
  if(!airborne){
    if(input.throttle)forward+=input.throttle*(input.throttle*forward<0?BRAKE:ACCELERATION)*dt;
    else forward-=Math.min(Math.abs(forward),DRAG*dt)*Math.sign(forward);
    if(useBoost&&input.throttle>=0)forward+=BOOST_ACCEL*dt;
    if(input.handbrake)forward*=Math.exp(-HANDBRAKE_DRAG*dt);
  }
  // A boost pad gives one burst per pass; overspeed then bleeds off instead of snapping back.
  const onPad=terrain.boostPads.some(pad=>covers(pad,state.x,state.z));
  const burst=onPad&&!state.onPad&&forward>0;
  if(burst)forward=Math.min(PAD_MAX,forward+PAD_BURST);
  const maximum=useBoost?BOOST_SPEED:MAX_SPEED;
  // Above the cap (pad burst, boost that just ended, a blast) the throttle cannot add speed: it only bleeds off.
  if(forward>maximum)forward=Math.max(maximum,Math.min(forward,before+(burst?PAD_BURST:0))-OVERSPEED_DECAY*dt);
  else forward=Math.max(-MAX_REVERSE,forward);
  lateral*=Math.exp(-(input.handbrake?DRIFT_GRIP:GRIP)*dt);
  let vx=fx*forward+rx*lateral,vz=fz*forward+rz*lateral;
  const speedFactor=Math.min(1,before/2.5)*(airborne?AIR_STEER:1);
  const heading=state.heading+steer*STEERING*(input.handbrake?HANDBRAKE_STEER:1)*speedFactor*Math.sign(forward||1)*dt;
  const clamp=value=>Math.max(-LIMIT,Math.min(LIMIT,value));
  let x=clamp(state.x+vx*dt),z=clamp(state.z+vz*dt);
  if(collides(x,z,obstacles)&&!collides(state.x,state.z,obstacles)) {
    if(!collides(x,state.z,obstacles)) {z=state.z;vz=0;}
    else if(!collides(state.x,z,obstacles)) {x=state.x;vx=0;}
    else {x=state.x;z=state.z;vx=0;vz=0;}
    forward=-vx*Math.sin(heading)-vz*Math.cos(heading);
  }
  // Vertical: ride the ramp surface, launch off its top edge, fall under gravity.
  const ground=groundHeight(x,z,terrain.ramps);
  let y=state.y,vy=state.vy;
  if(airborne){vy-=GRAVITY*dt;y+=vy*dt;if(y<=ground){y=ground;vy=0;}}
  else if(ground>=y-.35){y=ground;vy=0;}
  else{const ramp=terrain.ramps.find(r=>covers(r,state.x,state.z));vy=ramp?Math.max(0,forward)*ramp.height/ramp.length:0;y=state.y;}
  return {x,z,heading,vx,vz,steer,boostCharge,speed:forward,y,vy,onPad};
}
