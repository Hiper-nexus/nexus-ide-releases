// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: Nexus statement style.

import { describe, expect, it } from 'vitest';
import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError,
} from './json-text-structure-limit';

describe('JSON text structure admission', () => {
  it('preserves exact token and nesting boundaries', () => {
    expect(() =>
      assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
        structuralTokens: 7,
        nestingDepth: 3,
      }),
    ).not.toThrow();
  });

  it('rejects token and nesting limit +1', () => {
    expect(() =>
      assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
        structuralTokens: 6,
        nestingDepth: 3,
      }),
    ).toThrowError(new JsonTextStructureCapacityError('structuralTokens', 6));
    expect(() =>
      assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
        structuralTokens: 7,
        nestingDepth: 2,
      }),
    ).toThrowError(new JsonTextStructureCapacityError('nestingDepth', 2));
  });

  it('does not count escaped structural characters inside strings', () => {
    expect(() =>
      assertJsonTextStructureWithinLimits('{"value":"[{\\":,}]"}', {
        structuralTokens: 3,
        nestingDepth: 1,
      }),
    ).not.toThrow();
  });
});
