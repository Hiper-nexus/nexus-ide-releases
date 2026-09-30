import test from 'node:test';
import assert from 'node:assert/strict';
import { drive, initialVehicle } from './driving.js';

const WALL = [{x:0,z:-1,width:9,depth:1}];

test('acceleration moves the rover forward and leaves its input unchanged', () => {
  const initial=initialVehicle();
  const result=drive(initial,{throttle:1,steer:0},.1,[]);
  assert.ok(result.z<initial.z);
  assert.ok(result.speed>0);
  assert.deepEqual(initial,{x:0,z:9,heading:0,vx:0,vz:0,steer:0,boostCharge:1});
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
  assert.ok(Math.hypot(jump.x,jump.z-9)<=1.4);
  let state=initialVehicle();
  for(let i=0;i<600;i++)state=drive(state,{throttle:1,steer:0},.016,[]);
  assert.equal(state.boostCharge,1);
  const empty=drive({...initialVehicle(),vx:0,vz:7.9,boostCharge:0},{throttle:1,steer:0,boost:true},.1,[]);
  assert.ok(empty.speed<=8);
});
