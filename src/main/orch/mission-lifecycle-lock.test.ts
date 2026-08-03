import { afterEach, describe, expect, it, vi } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  MissionLifecycleLockBusyError,
  withMissionLifecycleLock,
} from "./mission-lifecycle-lock";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("mission lifecycle lock", () => {
  it("serializa teardown/delete e rearm/spawn da mesma missão", async () => {
    const scope = testProjectScope();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const removal = withMissionLifecycleLock(scope, "mission-a", async () => {
      order.push("remove:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("remove:end");
    });
    await firstEntered.promise;

    const recovery = withMissionLifecycleLock(scope, "mission-a", async () => {
      order.push("recover:start");
      order.push("recover:end");
    });
    await Promise.resolve();

    expect(order).toEqual(["remove:start"]);
    releaseFirst.resolve();
    await Promise.all([removal, recovery]);
    expect(order).toEqual([
      "remove:start",
      "remove:end",
      "recover:start",
      "recover:end",
    ]);
  });

  it("não bloqueia missões diferentes do mesmo workspace", async () => {
    const scope = testProjectScope();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withMissionLifecycleLock(scope, "mission-a", async () => {
      order.push("a:start");
      await releaseFirst.promise;
      order.push("a:end");
    });
    const second = withMissionLifecycleLock(scope, "mission-b", async () => {
      order.push("b");
    });

    await second;
    expect(order).toEqual(["a:start", "b"]);
    releaseFirst.resolve();
    await first;
  });

  it("libera a missão quando teardown ou bootstrap falha", async () => {
    const scope = testProjectScope();
    await expect(
      withMissionLifecycleLock(scope, "mission-failure", () => {
        throw new Error("physical teardown failed");
      }),
    ).rejects.toThrow("physical teardown failed");

    await expect(
      withMissionLifecycleLock(
        scope,
        "mission-failure",
        () => "recovery continued",
      ),
    ).resolves.toBe("recovery continued");
  });

  describe("timeout de aquisição", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("faz o waiter desistir sem rodar a operação; holder e fila seguem intactos", async () => {
      vi.useFakeTimers();
      const scope = testProjectScope();
      const releaseHolder = deferred();
      const order: string[] = [];

      const holder = withMissionLifecycleLock(scope, "mission-t", async () => {
        order.push("holder:start");
        await releaseHolder.promise;
        order.push("holder:end");
      });
      await Promise.resolve();

      const waiter = withMissionLifecycleLock(
        scope,
        "mission-t",
        async () => {
          order.push("waiter");
        },
        { acquireTimeoutMs: 30_000 },
      );
      // Attach BEFORE the timer fires, or the rejection floats unhandled.
      const waiterExpectation = expect(waiter).rejects.toBeInstanceOf(
        MissionLifecycleLockBusyError,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await waiterExpectation;
      expect(order).toEqual(["holder:start"]);

      const next = withMissionLifecycleLock(scope, "mission-t", async () => {
        order.push("next");
      });
      releaseHolder.resolve();
      await holder;
      await next;
      expect(order).toEqual(["holder:start", "holder:end", "next"]);
    });

    it("adquire normalmente quando o lock está livre", async () => {
      vi.useFakeTimers();
      const scope = testProjectScope();
      await expect(
        withMissionLifecycleLock(
          scope,
          "mission-free",
          () => "ok",
          { acquireTimeoutMs: 30_000 },
        ),
      ).resolves.toBe("ok");
    });
  });
});
