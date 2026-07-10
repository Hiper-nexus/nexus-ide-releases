import { describe, expect, it } from 'vitest';
import {
  detectFlowAxis,
  dropInsertionIndex,
  insertionToReorderIndex,
} from './browser-design-drag';

const rect = (x: number, y: number, width = 100, height = 40) => ({
  x,
  y,
  width,
  height,
});

const COLUMN = [rect(0, 0), rect(0, 50), rect(0, 100)];
const ROW = [rect(0, 0, 80), rect(100, 0, 80), rect(200, 0, 80)];

describe('detectFlowAxis', () => {
  it('detects vertical stacks and horizontal rows (flex/grid simples)', () => {
    expect(detectFlowAxis(COLUMN)).toBe('y');
    expect(detectFlowAxis(ROW)).toBe('x');
    expect(detectFlowAxis([rect(0, 0)])).toBe('y');
  });
});

describe('dropInsertionIndex', () => {
  it('counts sibling midpoints before the pointer on the flow axis', () => {
    // Column midpoints at y = 20, 70, 120.
    expect(dropInsertionIndex(COLUMN, { x: 10, y: 5 }, 'y')).toBe(0);
    expect(dropInsertionIndex(COLUMN, { x: 10, y: 45 }, 'y')).toBe(1);
    expect(dropInsertionIndex(COLUMN, { x: 10, y: 200 }, 'y')).toBe(3);
    // Row midpoints at x = 40, 140, 240.
    expect(dropInsertionIndex(ROW, { x: 150, y: 10 }, 'x')).toBe(2);
  });
});

describe('insertionToReorderIndex', () => {
  it('maps an insertion slot to the post-splice target index', () => {
    // Moving the last card (from 2) to the top slot (insertion 0) → toIndex 0.
    expect(insertionToReorderIndex(2, 0)).toBe(0);
    // Moving the first card (from 0) to the end slot (insertion 3) → toIndex 2.
    expect(insertionToReorderIndex(0, 3)).toBe(2);
    // Dropping right back over itself keeps the index.
    expect(insertionToReorderIndex(1, 1)).toBe(1);
    expect(insertionToReorderIndex(1, 2)).toBe(1);
  });
});
