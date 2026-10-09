import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PtyStreamMissionControl,
  type PtyStreamMissionControlPorts,
} from "./pty-stream-mission-control";

const SESSION_ID = "pty-maestro";
const CHANNEL_ID = "main-owned-channel-a";

function actionBlock(
  channelId: string,
  input: {
    readonly id?: string;
    readonly tool?: string;
    readonly args?: Record<string, unknown>;
  } = {},
): string {
  return [
    `### NEXUS_ACTION v1 ${channelId}`,
    JSON.stringify({
      id: input.id ?? "call-1",
      tool: input.tool ?? "nexus_task",
      args: input.args ?? { action: "list" },
    }),
  ].join("\n");
}

function harness(options: { readonly idle?: boolean } = {}) {
  let idle = options.idle ?? false;
  let authorized = true;
  const writes: string[] = [];
  const invoke = vi.fn<
    PtyStreamMissionControlPorts["invoke"]
  >(async (_sessionId, request) => ({
    ok: true,
    tool: request.tool,
    result: { tasks: [{ id: "task-a" }] },
  }));
  const ports: PtyStreamMissionControlPorts = {
    createChannelId: () => CHANNEL_ID,
    invoke,
    isAuthorized: () => authorized,
    isInjectableIdle: () => idle,
    write: (_sessionId, data) => {
      writes.push(data);
      return true;
    },
  };
  const control = new PtyStreamMissionControl(ports);
  return {
    control,
    invoke,
    writes,
    setIdle(value: boolean) {
      idle = value;
    },
    revoke() {
      authorized = false;
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider-independent PTY Maestro mission control", () => {
  it("publishes one session-bound protocol covering standard, plan and ops", () => {
    const { control } = harness();

    const instructions = control.instructionsForSession(SESSION_ID);

    expect(instructions).toContain(
      `### NEXUS_ACTION v1 ${CHANNEL_ID}`,
    );
    expect(instructions).toContain("nexus_task");
    expect(instructions).toContain("nexus_plan_write");
    expect(instructions).toContain("nexus_terminal_run");
    expect(instructions).toContain("nexus_handoff_submit");
    expect(instructions).toContain("pare o turno");
  });

  it("executes a split structured action once and returns its result only at an injectable idle boundary", async () => {
    vi.useFakeTimers();
    const { control, invoke, writes, setIdle } = harness();
    control.ensureChannel(SESSION_ID);
    const block = actionBlock(CHANNEL_ID);

    control.feed(SESSION_ID, block.slice(0, 23));
    control.feed(SESSION_ID, block.slice(23));
    await settle();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      SESSION_ID,
      {
        id: "call-1",
        tool: "nexus_task",
        args: { action: "list" },
      },
      CHANNEL_ID,
      expect.any(AbortSignal),
    );
    expect(writes).toEqual([]);

    setIdle(true);
    control.observeSessionState(SESSION_ID, "idle");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("[NEXUS_RESULT v1 id=call-1]");
    expect(writes[0]).toContain('"ok":true');
    expect(writes[0]).toContain('"task-a"');

    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toEqual([expect.any(String), "\r"]);

    control.observeSessionState(SESSION_ID, "busy");
    control.observeSessionState(SESSION_ID, "idle");
    expect(writes).toHaveLength(2);
  });

  it("ignores wrong-channel text, invalid prompt placeholders and TUI repaint duplicates", async () => {
    const { control, invoke } = harness();
    control.ensureChannel(SESSION_ID);
    const valid = actionBlock(CHANNEL_ID);

    control.feed(SESSION_ID, actionBlock("other-channel"));
    control.feed(
      SESSION_ID,
      actionBlock(CHANNEL_ID, { tool: "<nexus_tool>" }),
    );
    control.feed(SESSION_ID, valid);
    control.feed(SESSION_ID, `\u001b[2J${valid}`);
    await settle();

    expect(invoke).toHaveBeenCalledOnce();
  });

  it("revokes queued and future actions when the exact session channel is dropped", async () => {
    const { control, invoke, writes, setIdle, revoke } = harness();
    control.ensureChannel(SESSION_ID);

    control.feed(SESSION_ID, actionBlock(CHANNEL_ID));
    await settle();
    revoke();
    control.dropSession(SESSION_ID);
    setIdle(true);
    control.observeSessionState(SESSION_ID, "idle");
    control.feed(
      SESSION_ID,
      actionBlock(CHANNEL_ID, { id: "call-after-revoke" }),
    );
    await settle();

    expect(invoke).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it("returns an actionable failure without hiding a possibly committed effect", async () => {
    const { control, invoke, writes, setIdle } = harness();
    invoke.mockResolvedValueOnce({
      ok: false,
      tool: "nexus_terminal_run",
      error: "provider disconnected",
      effectMayHaveCommitted: true,
    });
    control.ensureChannel(SESSION_ID);

    control.feed(
      SESSION_ID,
      actionBlock(CHANNEL_ID, {
        id: "ops-1",
        tool: "nexus_terminal_run",
        args: { command: "deploy" },
      }),
    );
    await settle();
    setIdle(true);
    control.observeSessionState(SESSION_ID, "idle");

    expect(writes[0]).toContain('"ok":false');
    expect(writes[0]).toContain('"effectMayHaveCommitted":true');
    expect(writes[0]).toContain("Não repita cegamente");
  });

  it("drains a result swallowed twice without re-invoking its effect or blocking the next action", async () => {
    vi.useFakeTimers();
    const { control, invoke, writes } = harness({ idle: true });
    control.ensureChannel(SESSION_ID);
    control.feed(SESSION_ID, actionBlock(CHANNEL_ID));
    await settle();

    await vi.advanceTimersByTimeAsync(
      200 + 12_000 + 500 + 12_000,
    );
    expect(invoke).toHaveBeenCalledOnce();

    control.feed(
      SESSION_ID,
      actionBlock(CHANNEL_ID, {
        id: "call-2",
        tool: "nexus_mission_get",
        args: { missionId: "mission-a" },
      }),
    );
    await settle();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(writes.join("\n")).toContain("id=call-2");
  });
});
