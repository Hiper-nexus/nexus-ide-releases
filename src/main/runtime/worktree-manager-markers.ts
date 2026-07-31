export const INTERRUPTED_WORKTREE_RESERVATION_FAILURE_MARKER =
  "[NEXUS_INTERRUPTED_WORKTREE_RESERVATION]";

/**
 * failureReason prefix of a record released only because its owning task or
 * mission went terminal (blocked/done/failed). The physical worktree is
 * deliberately kept; the resume/retry lane may reclaim the slot through the
 * same taskKey after re-proving ownership exclusivity and Git identity.
 */
export const DEAD_OWNER_WORKTREE_RELEASE_MARKER =
  "[NEXUS_DEAD_OWNER_WORKTREE_RELEASE]";
