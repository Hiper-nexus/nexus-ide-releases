const ACCELERATION=14,DRAG=4,MAX_SPEED=8,BOOST_SPEED=12,STEERING=2.8,LIMIT=15,ROVER_RADIUS=.55;
export function initialVehicle() {return {x:0,z:9,heading:0,speed:0};}

function collides(position, obstacles) {
  return obstacles.some(obstacle=>Math.abs(position.x-obstacle.x)<obstacle.width/2+ROVER_RADIUS && Math.abs(position.z-obstacle.z)<obstacle.depth/2+ROVER_RADIUS);
}

export function drive(state,input,delta,obstacles) {
  const dt=Math.max(0,Math.min(delta,.1));
  const maximum=input.boost?BOOST_SPEED:MAX_SPEED;
  const thrust=input.throttle*ACCELERATION*dt;
  const friction=input.throttle===0?Math.min(Math.abs(state.speed),DRAG*dt)*Math.sign(state.speed):0;
  let speed=Math.max(-MAX_SPEED/2,Math.min(maximum,state.speed+thrust-friction));
  const heading=state.heading+input.steer*STEERING*dt*(speed<0?-1:1);
  const clamp=value=>Math.max(-LIMIT,Math.min(LIMIT,value));
  let x=clamp(state.x-Math.sin(heading)*speed*dt),z=clamp(state.z-Math.cos(heading)*speed*dt);
  if(collides({x,z},obstacles)) {x=state.x;z=state.z;speed=0;}
  return {x,z,heading,speed};
}
