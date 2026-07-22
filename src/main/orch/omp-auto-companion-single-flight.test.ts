import { describe, expect, it, vi } from 'vitest';
import { OmpAutoCompanionSingleFlight } from './omp-auto-companion-single-flight';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('OmpAutoCompanionSingleFlight', () => {
  it('allows exactly one concurrent companion per mission', async () => {
    const flights = new OmpAutoCompanionSingleFlight();
    const pending = deferred();
    const spawn = vi.fn(() => pending.promise);
    const onError = vi.fn();

    expect(flights.start('project:checkout:mission', spawn, onError)).toBe(true);
    expect(flights.start('project:checkout:mission', spawn, onError)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);

    pending.resolve();
    await pending.promise;
    await vi.waitFor(() => {
      expect(
        flights.start(
          'project:checkout:mission',
          vi.fn(async () => {}),
          onError,
        ),
      ).toBe(true);
    });
  });

  it('releases the mission key after failure and reports the cause', async () => {
    const flights = new OmpAutoCompanionSingleFlight();
    const onError = vi.fn();
    const cause = new Error('omp unavailable');

    expect(
      flights.start('mission', async () => {
        throw cause;
      }, onError),
    ).toBe(true);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(cause));
    await vi.waitFor(() => {
      expect(flights.start('mission', vi.fn(async () => {}), onError)).toBe(true);
    });
  });
});
