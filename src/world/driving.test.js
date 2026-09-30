import test from 'node:test';
import assert from 'node:assert/strict';
import { drive, initialVehicle } from './driving.js';

test('acceleration moves the rover forward and leaves its input unchanged', () => {
  const initial=initialVehicle();
  const result=drive(initial,{throttle:1,steer:0},.1,[]);
  assert.ok(result.z<initial.z);
  assert.ok(result.speed>0);
  assert.equal(initial.speed,0);
});

test('a solid obstacle prevents driving through it', () => {
  const initial={x:0,z:0,heading:0,speed:8};
  const result=drive(initial,{throttle:1,steer:0},.1,[{x:0,z:-1,width:4,depth:1}]);
  assert.equal(result.z,initial.z);
  assert.equal(result.speed,0);
});

test('boost respects the speed cap and long frames do not teleport', () => {
  const initial={...initialVehicle(),speed:10};
  const result=drive(initial,{throttle:1,steer:0,boost:true},100,[]);
  assert.ok(Math.hypot(result.x-initial.x,result.z-initial.z)<=1.4);
  assert.ok(result.speed<=12);
});
