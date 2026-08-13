import { canUseNexusMcp } from "./cli-mcp-inject";

/**
 * Physical handoff contract every CLI adapter must honour.
 *
 * Overclock does not inject MCP into AGY/Gemini; it observes the last
 * assistant turn (Stop-hook / transcript) and submits handoff itself.
 * Nexus mirrors that for every adapter: MCP when the CLI can actually
 * load it, `nx-mail` on PATH for workers, and Main-owned PTY scrape as
 * the path that must always land.
 */
export interface AdapterHandoffTransport {
  readonly mcpTool: boolean;
  readonly nxMail: true;
  readonly ptyScrape: true;
}

export function handoffTransportForAdapter(adapter: {
  quirks: { mcpAutoload?: boolean; nexusMcp?: unknown };
}): AdapterHandoffTransport {
  return {
    mcpTool: canUseNexusMcp(adapter),
    nxMail: true,
    ptyScrape: true,
  };
}
