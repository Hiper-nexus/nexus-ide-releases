/** Private per-session Claude-family hook. The helper reads its Main-selected
 * node/resource locations from env; no bearer or tool input appears in argv. */
export function claudeNativeHeavyHookCommand(): string {
  return 'NODE_OPTIONS= NEXUS_HOOK_STATUS=1 NEXUS_HEAVY_TOOL_PREEXEC=1 "$NEXUS_HEAVY_NODE" "$NEXUS_HEAVY_DIR/tool-hook.cjs"';
}
