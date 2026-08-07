import { describe, expect, it } from 'vitest';
import {
  reduceMissionLifecycle,
  type MissionLifecycleEvent,
  type MissionLifecyclePair,
} from './mission-engine-state';

const ZERO_WORK = { pending: 0, inFlight: 0, handoffs: 0 } as const;

describe('reduceMissionLifecycle', () => {
  it.each(
    [
      {
        name: 'review-ready',
        current: { status: 'pending', intentState: 'intent_compiling' },
        event: { kind: 'review-ready' },
        expected: { status: 'pending', intentState: 'ready_to_start' },
      },
      {
        name: 'start',
        current: { status: 'pending', intentState: 'ready_to_start' },
        event: { kind: 'start' },
        expected: { status: 'running', intentState: 'dispatched' },
      },
      {
        name: 'kickoff-accepted',
        current: { status: 'running', intentState: 'dispatched' },
        event: { kind: 'kickoff-accepted' },
        expected: { status: 'running', intentState: 'executing' },
      },
      {
        name: 'block-user',
        current: { status: 'running', intentState: 'executing' },
        event: { kind: 'block-user' },
        expected: { status: 'blocked', intentState: 'blocked_user' },
      },
      {
        name: 'block-technical',
        current: { status: 'running', intentState: 'validating' },
        event: { kind: 'block-technical' },
        expected: { status: 'blocked', intentState: 'blocked_technical' },
      },
      {
        name: 'answer',
        current: { status: 'blocked', intentState: 'blocked_user' },
        event: { kind: 'answer' },
        expected: { status: 'running', intentState: 'executing' },
      },
      {
        name: 'recover',
        current: { status: 'blocked', intentState: 'blocked_technical' },
        event: { kind: 'recover' },
        expected: { status: 'running', intentState: 'executing' },
      },
      {
        name: 'stop',
        current: { status: 'blocked', intentState: 'blocked_user' },
        event: { kind: 'stop' },
        expected: { status: 'failed', intentState: 'blocked_technical' },
      },
      {
        name: 'fail',
        current: { status: 'pending', intentState: 'ready_to_start' },
        event: { kind: 'fail' },
        expected: { status: 'failed', intentState: 'blocked_technical' },
      },
      {
        name: 'complete',
        current: { status: 'running', intentState: 'validating' },
        event: { kind: 'complete', verification: ZERO_WORK },
        expected: { status: 'done', intentState: 'done' },
      },
    ] satisfies ReadonlyArray<{
      name: string;
      current: MissionLifecyclePair;
      event: MissionLifecycleEvent;
      expected: MissionLifecyclePair;
    }>,
  )('returns the complete coherent pair for $name', ({ current, event, expected }) => {
    expect(reduceMissionLifecycle(current, event)).toEqual(expected);
  });

  it.each([
    { pending: 1, inFlight: 0, handoffs: 0 },
    { pending: 0, inFlight: 1, handoffs: 0 },
    { pending: 0, inFlight: 0, handoffs: 1 },
  ])('refuses completion while work remains: %o', (verification) => {
    expect(() =>
      reduceMissionLifecycle(
        { status: 'running', intentState: 'executing' },
        { kind: 'complete', verification },
      ),
    ).toThrow(/pending work/i);
  });

  it('allows answer only from a user block and recover only from a technical block', () => {
    expect(() =>
      reduceMissionLifecycle(
        { status: 'blocked', intentState: 'blocked_technical' },
        { kind: 'answer' },
      ),
    ).toThrow(/invalid transition/i);
    expect(() =>
      reduceMissionLifecycle(
        { status: 'blocked', intentState: 'blocked_user' },
        { kind: 'recover' },
      ),
    ).toThrow(/invalid transition/i);
  });

  it('rejects completion before execution is active', () => {
    expect(() =>
      reduceMissionLifecycle(
        { status: 'running', intentState: 'dispatched' },
        { kind: 'complete', verification: ZERO_WORK },
      ),
    ).toThrow(/invalid transition/i);
  });

  it.each([
    { status: 'pending', intentState: 'executing' },
    { status: 'running', intentState: 'blocked_user' },
    { status: 'failed', intentState: 'done' },
  ] as const)('rejects an incoherent current pair: %o', (current) => {
    expect(() =>
      reduceMissionLifecycle(current, { kind: 'block-technical' }),
    ).toThrow(/invalid lifecycle pair/i);
  });

  it.each([
    { status: 'done', intentState: 'done' },
    { status: 'failed', intentState: 'blocked_technical' },
  ] as const)('rejects transitions from a terminal pair: %o', (current) => {
    expect(() => reduceMissionLifecycle(current, { kind: 'stop' })).toThrow(
      /terminal mission/i,
    );
  });
});
