import test from 'node:test';
import assert from 'node:assert/strict';
import { initialProgress, advanceQuest, readProgress, progressView } from './quests.js';

test('visiting a station awards XP once and never creates raffle eligibility', () => {
  const initial=initialProgress();
  const visited=advanceQuest(initial,{type:'station',id:'claude'});
  const duplicate=advanceQuest(visited,{type:'station',id:'claude'});
  assert.equal(visited.xp,100);
  assert.deepEqual(duplicate,visited);
  assert.equal(initial.xp,0);
  assert.equal('raffleEligible' in visited,false);
});

test('each detonated barrel adds XP and the demolition mission counts three', () => {
  let state=initialProgress();
  state=advanceQuest(state,{type:'barrel'});
  state=advanceQuest(state,{type:'barrel'});
  assert.equal(state.barrels,2);
  assert.equal(state.xp,100);
  assert.equal(progressView(state).completed,0);
  state=advanceQuest(state,{type:'barrel'});
  assert.equal(progressView(state).completed,1);
  assert.equal(progressView(state).complete,false);
  assert.deepEqual(initialProgress().barrels,0);
});

test('barrel XP is capped at the mission size so respawn farming pays nothing', () => {
  let state=initialProgress();
  for(let i=0;i<9;i++)state=advanceQuest(state,{type:'barrel'});
  assert.equal(state.xp,150);
  assert.equal(state.barrels,9);
});

test('completing the tour requires stations, coffees and the demolition', () => {
  let state=initialProgress();
  for(const id of ['claude','codex','live']) state=advanceQuest(state,{type:'station',id});
  assert.equal(progressView(state).complete,false);
  for(let id=0;id<5;id++) state=advanceQuest(state,{type:'coffee',id});
  for(let i=0;i<3;i++) state=advanceQuest(state,{type:'barrel'});
  const view=progressView(state);
  assert.equal(view.complete,true);
  assert.equal(view.completed,5);
  assert.equal(view.level,3);
  assert.equal(view.title,'Builder');
});

test('untrusted stored XP is recalculated from known achievements', () => {
  const state=readProgress('{"stations":["claude","claude","unknown"],"coffees":[0,0,99],"barrels":2,"xp":999999}');
  assert.deepEqual(state.stations,['claude']);
  assert.deepEqual(state.coffees,[0]);
  assert.equal(state.barrels,2);
  assert.equal(state.xp,225);
  const negative=readProgress('{"barrels":-4,"coffees":[],"stations":[]}');
  assert.equal(negative.barrels,0);
  assert.deepEqual(readProgress('invalid'),initialProgress());
});
