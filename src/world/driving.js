const ACCELERATION=16,BRAKE=12,DRAG=4,MAX_SPEED=8,MAX_REVERSE=4,BOOST_SPEED=12.5,BOOST_ACCEL=8,
STEERING=2.6,STEER_SPEED=10,GRIP=10,DRIFT_GRIP=1.6,HANDBRAKE_STEER=1.5,HANDBRAKE_DRAG=.25,
BOOST_DRAIN=.45,BOOST_REGEN=.18,LIMIT=15,ROVER_RADIUS=.55;
export function initialVehicle() {return {x:0,z:9,heading:0,vx:0,vz:0,steer:0,boostCharge:1};}

function seeded(state) {
  if(state.vx!=null&&state.vz!=null)return state;
  const speed=state.speed||0;
  return {...state,vx:-Math.sin(state.heading)*speed,vz:-Math.cos(state.heading)*speed};
}

function collides(x,z,obstacles) {
  return obstacles.some(obstacle=>Math.abs(x-obstacle.x)<obstacle.width/2+ROVER_RADIUS && Math.abs(z-obstacle.z)<obstacle.depth/2+ROVER_RADIUS);
}

export function drive(rawState,input,delta,obstacles) {
  const state=seeded(rawState);
  const dt=Math.max(0,Math.min(delta,.1));
  const maxStep=STEER_SPEED*dt;
  const steer=state.steer+Math.max(-maxStep,Math.min(maxStep,input.steer-state.steer));
  const useBoost=input.boost&&state.boostCharge>0;
  const boostCharge=useBoost?Math.max(0,state.boostCharge-BOOST_DRAIN*dt):Math.min(1,state.boostCharge+BOOST_REGEN*dt);
  const fx=-Math.sin(state.heading),fz=-Math.cos(state.heading),rx=Math.cos(state.heading),rz=-Math.sin(state.heading);
  let forward=state.vx*fx+state.vz*fz;
  let lateral=state.vx*rx+state.vz*rz;
  const before=Math.abs(forward);
  if(input.throttle)forward+=input.throttle*(input.throttle*forward<0?BRAKE:ACCELERATION)*dt;
  else forward-=Math.min(Math.abs(forward),DRAG*dt)*Math.sign(forward);
  if(useBoost&&input.throttle>=0)forward+=BOOST_ACCEL*dt;
  if(input.handbrake)forward*=Math.exp(-HANDBRAKE_DRAG*dt);
  const maximum=useBoost?BOOST_SPEED:MAX_SPEED;
  forward=Math.max(-MAX_REVERSE,Math.min(maximum,forward));
  lateral*=Math.exp(-(input.handbrake?DRIFT_GRIP:GRIP)*dt);
  let vx=fx*forward+rx*lateral,vz=fz*forward+rz*lateral;
  const speedFactor=Math.min(1,before/2.5);
  const heading=state.heading+steer*STEERING*(input.handbrake?HANDBRAKE_STEER:1)*speedFactor*Math.sign(forward||1)*dt;
  const clamp=value=>Math.max(-LIMIT,Math.min(LIMIT,value));
  let x=clamp(state.x+vx*dt),z=clamp(state.z+vz*dt);
  if(collides(x,z,obstacles)&&!collides(state.x,state.z,obstacles)) {
    if(!collides(x,state.z,obstacles)) {z=state.z;vz=0;}
    else if(!collides(state.x,z,obstacles)) {x=state.x;vx=0;}
    else {x=state.x;z=state.z;vx=0;vz=0;}
    forward=-vx*Math.sin(heading)-vz*Math.cos(heading);
  }
  return {x,z,heading,vx,vz,steer,boostCharge,speed:forward};
}
