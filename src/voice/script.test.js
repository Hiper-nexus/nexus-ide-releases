import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, PHASES, barScale, buildTimeline, finalState, levelAt } from './script.js';

test('every example keeps what the speaker meant and marks what the refinement drops', () => {
  assert.ok(EXAMPLES.length >= 3);
  for (const example of EXAMPLES) {
    assert.ok(example.spoken.some(token => !token.drop), example.id);
    assert.ok(example.prompt.length >= 1, example.id);
    if (example.mode === 'chat') assert.equal(example.spoken.some(token => token.drop), false, 'CHAT keeps the speech as spoken');
  }
  assert.equal(new Set(EXAMPLES.map(example => example.id)).size, EXAMPLES.length);
});

test('the timeline follows the app phases in order and only refines in CODE mode', () => {
  const code = buildTimeline(EXAMPLES.find(example => example.mode === 'code'));
  assert.deepEqual(code.filter(step => step.type === 'phase').map(step => step.phase), ['listening', 'transcribing', 'refining', 'delivered']);
  const chat = buildTimeline(EXAMPLES.find(example => example.mode === 'chat'));
  assert.deepEqual(chat.filter(step => step.type === 'phase').map(step => step.phase), ['listening', 'transcribing', 'delivered']);
  for (const phase of ['listening', 'transcribing', 'refining', 'delivered']) assert.equal(typeof PHASES[phase], 'string');
});

test('words are heard before transcription ends and the prompt only appears after the refinement starts', () => {
  for (const example of EXAMPLES) {
    const steps = buildTimeline(example);
    const at = (predicate) => steps.find(predicate).at;
    const words = steps.filter(step => step.type === 'word');
    assert.equal(words.length, example.spoken.length);
    assert.ok(words.at(-1).at < at(step => step.type === 'phase' && step.phase === 'transcribing'));
    const lines = steps.filter(step => step.type === 'line');
    assert.deepEqual(lines.map(step => step.text), example.prompt);
    const gate = example.mode === 'code' ? 'refining' : 'transcribing';
    assert.ok(lines[0].at > at(step => step.type === 'phase' && step.phase === gate));
    assert.equal(steps.at(-1).type, 'phase');
    assert.equal(steps.at(-1).phase, 'delivered');
    assert.ok(steps.every((step, index) => index === 0 || step.at >= steps[index - 1].at), 'steps are sorted');
    assert.ok(steps.at(-1).at <= 12_000, 'a replay stays short');
  }
});

test('the final state equals what a full replay leaves on screen', () => {
  for (const example of EXAMPLES) {
    const state = finalState(example);
    assert.equal(state.phase, 'delivered');
    assert.deepEqual(state.lines, example.prompt);
    assert.equal(state.words.length, example.spoken.length);
    assert.equal(state.struck, example.mode === 'code');
  }
});

test('microphone level is deterministic, bounded and silent once listening ends', () => {
  for (let time = 0; time < 4000; time += 37) {
    const level = levelAt(time, 3000);
    assert.ok(level >= 0 && level <= 1);
    assert.equal(level, levelAt(time, 3000));
  }
  assert.equal(levelAt(3000, 3000), 0);
  assert.equal(levelAt(5000, 3000), 0);
});

test('level bars read like a VU meter: centre tallest, edges lowest, never invisible', () => {
  const scales = Array.from({ length: 7 }, (_, index) => barScale(0.8, index, 7));
  assert.ok(scales[3] > scales[1] && scales[1] > scales[0]);
  assert.deepEqual(scales, [...scales].reverse());
  for (const level of [0, -1, Number.NaN, 2]) for (let index = 0; index < 7; index++) {
    const scale = barScale(level, index, 7);
    assert.ok(scale >= 0.06 && scale <= 1);
  }
});
