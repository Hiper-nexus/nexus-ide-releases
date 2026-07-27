import { TASK_DISPATCH_HEARTBEAT_LEASE_MS } from "./task-dispatch-lifecycle";

export const MISSION_SCHEDULER_TICK_MS = 5_000;

export const MISSION_SCHEDULER_WORKER_LEASE_POLICY = Object.freeze({
  claimLeaseMs: TASK_DISPATCH_HEARTBEAT_LEASE_MS,
  heartbeatIntervalMs: 4 * 60_000,
});
