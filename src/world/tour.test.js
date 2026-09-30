import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, TOUR_SIZE, TOUR_AWARD, initialTour, visitTotem, tourProgress, modelBlurb, modelName } from './tour.js';

test('the tour lists every provider with an icon, a colour and a one-liner', () => {
  assert.equal(MODELS.length, TOUR_SIZE);
  const ids = new Set();
  for (const model of MODELS) {
    assert.ok(model.id && !ids.has(model.id), `unique id ${model.id}`);
    ids.add(model.id);
    assert.ok(model.icon && model.icon.length > 3, `${model.id} has an icon file`);
    assert.ok(Number.isInteger(model.color), `${model.id} has a brand colour`);
    assert.ok(model.blurb && model.blurb.length > 8, `${model.id} has a blurb`);
  }
});

test('visiting a totem is idempotent and unknown ids are ignored', () => {
  const start = initialTour();
  assert.deepEqual(start.visited, []);
  const once = visitTotem(start, 'codex');
  assert.deepEqual(once.visited, ['codex']);
  assert.equal(visitTotem(once, 'codex'), once, 'a second pass returns the same state');
  assert.equal(visitTotem(once, 'nope'), once, 'unknown ids do not mutate');
});

test('progress counts visits and flips complete only after all eighteen', () => {
  let tour = initialTour();
  for (const model of MODELS) {
    tour = visitTotem(tour, model.id);
    const view = tourProgress(tour);
    assert.equal(view.count, MODELS.indexOf(model) + 1);
    assert.equal(view.complete, view.count === TOUR_SIZE);
    assert.equal(view.label, `${view.count}/${TOUR_SIZE}`);
  }
  assert.ok(tourProgress(tour).complete);
});

test('blurbs and names resolve by id, with a safe fallback', () => {
  assert.equal(modelName('codex'), 'Codex');
  assert.ok(modelBlurb('kimi').length > 8);
  assert.equal(modelName('desconhecido'), 'desconhecido');
  assert.equal(modelBlurb('desconhecido'), '');
});

test('the tour badge is worth local XP only', () => {
  assert.equal(typeof TOUR_AWARD, 'number');
  assert.ok(TOUR_AWARD > 0);
});
