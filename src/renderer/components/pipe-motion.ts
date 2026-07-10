export const PIPE_ACTIVITY_MOTION_MS = 900;

export function isPipeRecentlyActive(
  lastDeliveredAt: number | undefined,
  now: number,
): boolean {
  if (
    !Number.isFinite(lastDeliveredAt) ||
    !Number.isFinite(now) ||
    lastDeliveredAt === undefined ||
    lastDeliveredAt > now
  ) {
    return false;
  }
  return now - lastDeliveredAt <= PIPE_ACTIVITY_MOTION_MS;
}
