import test from 'node:test';
import assert from 'node:assert/strict';
import { drive, initialVehicle } from './driving.js';

const WALL = [{x:0,z:-1,width:9,depth:1}];

test('acceleration moves the rover forward and leaves its input unchanged', () => {
  const initial=initialVehicle();
  const result=drive(initial,{throttle:1,steer:0},.1,[]);
  assert.ok(result.z<initial.z);
  assert.ok(result.speed>0);
  assert.deepEqual(initial,{x:0,z:18,heading:0,vx:0,vz:0,steer:0,boostCharge:1,y:0,vy:0,onPad:false});
});

test('a stationary rover does not turn like a tank, but low speed still steers', () => {
  const parked=drive({...initialVehicle(),vx:0,vz:0},{throttle:0,steer:1},.2,[]);
  assert.equal(parked.heading,0);
  const crawling=drive({...initialVehicle(),vx:0,vz:-1},{throttle:0,steer:1},.2,[]);
  assert.ok(crawling.heading>0);
});

test('steering input is smoothed instead of snapping', () => {
  const first=drive(initialVehicle(),{throttle:1,steer:1},.016,[]);
  assert.ok(first.steer>0&&first.steer<1);
  let state=initialVehicle();
  for(let i=0;i<120;i++)state=drive(state,{throttle:1,steer:1},.016,[]);
  assert.ok(state.steer>.95);
});

test('reverse drives backward and steering flips with it', () => {
  const reversed=drive(initialVehicle(),{throttle:-1,steer:0},.4,[]);
  assert.ok(reversed.z>9);
  const forwardTurn=drive({...initialVehicle(),vx:0,vz:-4},{throttle:0,steer:1},.3,[]);
  const reverseTurn=drive({...initialVehicle(),vx:0,vz:4},{throttle:0,steer:1},.3,[]);
  assert.ok(forwardTurn.heading>0);
  assert.ok(reverseTurn.heading<0);
});

test('handbrake trades grip for a wider drift angle', () => {
  const frames=(handbrake)=>{let state={...initialVehicle(),vx:0,vz:-6};
    for(let i=0;i<40;i++)state=drive(state,{throttle:.5,steer:1,handbrake},.05,[]);
    return state;};
  const grip=frames(false),drift=frames(true);
  const lateral=state=>Math.abs(state.vx*Math.cos(state.heading)-state.vz*Math.sin(state.heading));
  const slip=state=>lateral(state)/Math.hypot(state.vx,state.vz);
  assert.ok(slip(drift)>slip(grip));
  assert.ok(Math.hypot(drift.vx,drift.vz)<Math.hypot(grip.vx,grip.vz));
});

test('a wall makes the rover slide along it instead of dead stopping', () => {
  const base={x:0,z:.5,heading:.1,vx:-Math.sin(.1)*6,vz:-Math.cos(.1)*6,steer:0,boostCharge:1};
  const result=drive(base,{throttle:1,steer:0},.1,WALL);
  assert.equal(result.z,base.z);
  assert.ok(Math.abs(result.x-base.x)>0);
  assert.equal(result.vz,0);
  assert.ok(Math.abs(result.vx)>0);
});

test('a corner that blocks both axes stops the rover', () => {
  const corner=[{x:0,z:-.4,width:9,depth:1.4},{x:-.9,z:0,width:.5,depth:40}];
  const base={x:0,z:1.2,heading:.2,vx:-Math.sin(.2)*6,vz:-Math.cos(.2)*6,steer:0,boostCharge:1};
  const result=drive(base,{throttle:1,steer:0},.1,corner);
  assert.equal(result.z,base.z);
  assert.equal(result.x,base.x);
  assert.ok(result.speed===0);
});

test('boost drains its charge, respects the cap and long frames do not teleport', () => {
  const base={...initialVehicle(),speed:0};
  let boosting=drive(base,{throttle:1,steer:0,boost:true},.1,[]);
  assert.ok(boosting.boostCharge<1);
  assert.ok(boosting.speed<=12.5);
  const jump=drive({...initialVehicle(),vx:0,vz:10},{throttle:1,steer:0,boost:true},100,[]);
  assert.ok(Math.hypot(jump.x,jump.z-initialVehicle().z)<=1.4);
  let state=initialVehicle();
  for(let i=0;i<600;i++)state=drive(state,{throttle:1,steer:0},.016,[]);
  assert.equal(state.boostCharge,1);
  const empty=drive({...initialVehicle(),vx:0,vz:7.9,boostCharge:0},{throttle:1,steer:0,boost:true},.1,[]);
  assert.ok(empty.speed<=8);
});

test('a ramp lifts the rover, launches it off the top and gravity brings it back down', () => {
  const ramp = { x: 0, z: -10, heading: 0, length: 6, width: 4, height: 1.6 };
  let state = { ...initialVehicle(), x: 0, z: -4, heading: 0, vx: 0, vz: -9, y: 0, vy: 0 };
  let peak = 0, launched = false, landed = false;
  for (let i = 0; i < 240; i++) {
    state = drive(state, { throttle: 1, steer: 0 }, 1 / 60, [], { ramps: [ramp], boostPads: [] });
    peak = Math.max(peak, state.y);
    if (state.z < ramp.z - ramp.length / 2 - 0.2 && state.y > 0.2) launched = true;
    if (launched && state.y === 0) landed = true;
  }
  assert.ok(peak > ramp.height, 'the rover climbs above the top of the ramp');
  assert.ok(launched, 'it leaves the top edge in the air');
  assert.ok(landed, 'and comes back to the ground');
});

test('a boost pad gives one burst per pass instead of a permanent speed bonus', () => {
  const pad = { x: 0, z: -6, heading: 0, length: 3, width: 3 };
  let state = { ...initialVehicle(), z: -3, vz: -6 };
  const before = Math.abs(state.vz);
  const speeds = [];
  for (let i = 0; i < 90; i++) { state = drive(state, { throttle: 0, steer: 0 }, 1 / 60, [], { ramps: [], boostPads: [pad] }); speeds.push(Math.hypot(state.vx, state.vz)); }
  assert.ok(Math.max(...speeds) > before + 3, 'crossing the pad pushes the rover');
  assert.ok(speeds.at(-1) < Math.max(...speeds), 'and drag takes over again afterwards');
});

test('holding the throttle never exceeds the top speed, and a pad burst still bleeds back to it', () => {
  let state={...initialVehicle(),vz:-7.9};
  for(let i=0;i<300;i++)state=drive(state,{throttle:1,steer:0},1/60,[]);
  assert.ok(Math.hypot(state.vx,state.vz)<=8.01);
  const pad={x:0,z:-6,heading:0,length:3,width:3};
  let pushed={...initialVehicle(),z:-3,vz:-8};
  let peak=0;
  for(let i=0;i<240;i++){pushed=drive(pushed,{throttle:1,steer:0},1/60,[],{ramps:[],boostPads:[pad]});peak=Math.max(peak,Math.hypot(pushed.vx,pushed.vz));}
  assert.ok(peak<=13.01,'one burst on top of the cap');
  assert.ok(Math.hypot(pushed.vx,pushed.vz)<=8.01,'back at the cap afterwards');
});
