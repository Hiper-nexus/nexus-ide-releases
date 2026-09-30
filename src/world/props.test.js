import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBarrels, hitBarrel, detonateBarrel, stepBarrels, stepProps, pushProp, blastImpulse, breakCrates, shatterCrates, PROP_LIMIT } from './props.js';

test('a fast rover detonates a barrel it touches, a slow or distant one does not', () => {
  const barrels=initialBarrels();
  const near=barrels[0];
  const touch={x:near.x,z:near.z,vx:0,vz:-5};
  assert.equal(hitBarrel(touch,barrels,3),near.id);
  assert.equal(hitBarrel({...touch,vx:0,vz:-1},barrels,3),null);
  assert.equal(hitBarrel({x:near.x+4,z:near.z,vx:0,vz:-5},barrels,3),null);
  assert.equal(hitBarrel(touch,detonateBarrel(barrels,near.id),3),null);
  assert.deepEqual(barrels.map(b=>b.alive),barrels.map(()=>true));
});

test('a detonated barrel returns after its respawn window', () => {
  let barrels=detonateBarrel(initialBarrels(),0);
  assert.equal(barrels.find(b=>b.id===0).alive,false);
  barrels=stepBarrels(barrels,5.9);
  assert.equal(barrels.find(b=>b.id===0).alive,false);
  barrels=stepBarrels(barrels,.2);
  assert.equal(barrels.find(b=>b.id===0).alive,true);
  assert.equal(barrels.find(b=>b.id===0).respawn,0);
});

test('pushing a prop sends it away from the rover and friction brings it to rest', () => {
  const prop={id:'cone-1',x:2,z:0,vx:0,vz:0};
  const pushed=pushProp(prop,0,0,4);
  assert.ok(pushed.vx>0);
  assert.equal(prop.vx,0);
  let moving=pushed;
  for(let i=0;i<200;i++)moving=stepProps([moving],.05)[0];
  assert.ok(Math.abs(moving.vx)<.01&&Math.abs(moving.vz)<.01);
  assert.ok(moving.x>prop.x);
  const overlapping=pushProp({id:'cone-2',x:1,z:0,vx:0,vz:0},1,0,4);
  assert.ok(Number.isFinite(overlapping.vx)&&Number.isFinite(overlapping.vz));
});

test('props never leave the world even with a huge frame', () => {
  const [next]=stepProps([{id:'crate',x:5,z:5,vx:-900,vz:900}],100);
  assert.ok(Math.abs(next.x)<=PROP_LIMIT&&Math.abs(next.z)<=PROP_LIMIT);
});

test('a blast shoves the rover harder the closer it detonates', () => {
  const barrels=initialBarrels();
  const barrel=barrels[0];
  const close=blastImpulse({x:barrel.x+1,z:barrel.z,vx:0,vz:0},barrel,10);
  const far=blastImpulse({x:barrel.x+5,z:barrel.z,vx:0,vz:0},barrel,10);
  assert.ok(close.vx>0&&Math.abs(close.vx)>Math.abs(far.vx));
  assert.equal(blastImpulse({x:barrel.x+99,z:barrel.z},barrel,10).vx,0);
});

test('props and barrels at rest step to the same array, so the frame loop allocates nothing', () => {
  const props=[{id:'cone-1',x:2,z:0,vx:0,vz:0},{id:'crate-1',x:-3,z:4,vx:0,vz:0}];
  assert.equal(stepProps(props,.016),props);
  assert.notEqual(stepProps([pushProp(props[0],0,0,4),props[1]],.016),props);
  const barrels=initialBarrels();
  assert.equal(stepBarrels(barrels,.016),barrels);
  assert.notEqual(stepBarrels(detonateBarrel(barrels,0),.016),barrels);
});

test('a crate shatters when it is shoved hard enough, a gentle nudge leaves it standing', () => {
  const props=[{id:1,kind:'crate',x:0,z:0,vx:5,vz:0},{id:2,kind:'crate',x:2,z:0,vx:1,vz:0},{id:3,kind:'cone',x:4,z:0,vx:9,vz:0}];
  assert.deepEqual(breakCrates(props),[1]);
  assert.deepEqual(breakCrates(props,6),[], 'the threshold can be raised');
  const broken=shatterCrates(props,[1]);
  assert.equal(broken[0].broken,true);
  assert.equal(broken[0].vx,0);
  assert.equal(broken[1].broken,undefined);
  assert.equal(shatterCrates(props,[]),props,'nothing to break keeps the same array');
});
