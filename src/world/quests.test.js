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

test('completing the tour requires all three stations and all five coffees', () => {
  let state=initialProgress();
  for(const id of ['claude','codex','live']) state=advanceQuest(state,{type:'station',id});
  assert.equal(progressView(state).complete,false);
  for(let id=0;id<5;id++) state=advanceQuest(state,{type:'coffee',id});
  assert.equal(progressView(state).complete,true);
  assert.equal(progressView(state).completed,4);
});

test('untrusted stored XP is recalculated from known achievements', () => {
  const state=readProgress('{"stations":["claude","claude","unknown"],"coffees":[0,0,99],"xp":999999}');
  assert.deepEqual(state.stations,['claude']);
  assert.deepEqual(state.coffees,[0]);
  assert.equal(state.xp,125);
  assert.deepEqual(readProgress('invalid'),initialProgress());
});
