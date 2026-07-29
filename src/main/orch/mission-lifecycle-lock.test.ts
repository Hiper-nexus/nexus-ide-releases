import { describe, expect, it } from "vitest";
import { testProjectScope } from "./__tests__/scope-fixture";
import { withMissionLifecycleLock } from "./mission-lifecycle-lock";

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
});
