![DESIGNmd](https://designmd.ai/logo.svg)

# Install the DESIGNmd MCP

Only ~2K tokens context

The DESIGNmd MCP server lets your AI coding tool search, browse, and download design systems directly — without visiting the website. It's a thin MCP with 7 tools, adding roughly 2K tokens to your context window. Works with any MCP-compatible tool.

1

## Create an API key

You need a free API key to download design systems via MCP. Searching and browsing work without one. [Create your API key here](https://designmd.ai/api-keys).

2

## Install

Add the MCP server to your AI coding tool with your API key.

### Claude Code

```
claude mcp add -s user designmd -e DESIGNMD_API_KEY=dk_your-key-here -- npx designmd-mcp
```

Copy

### Cursor, Antigravity, and others

Add to your MCP config file (`.cursor/mcp.json`, `~/.gemini/antigravity/mcp_config.json`, etc.):

```
{
  "mcpServers": {
    "designmd": {
      "command": "npx",
      "args": ["designmd-mcp"],
      "env": {
        "DESIGNMD_API_KEY": "dk_your-key-here"
      }
    }
  }
}
```

Copy

## What you can do with it

Once installed, you can ask your AI coding agent things like:

- "Search DESIGNmd for a dark fintech design system"
- "Download the Neon Fintech design system and save it as DESIGN.md"
- "Find a minimal SaaS design system with Tailwind colors"
- "Show me trending design systems on DESIGNmd"
- "What tags are available on DESIGNmd?"
- "Upload my DESIGN.md to DESIGNmd"
- "Delete my old design system from DESIGNmd"

Searching and browsing work without an API key. Downloading, viewing content, uploading, and deleting all require one.

Want zero context window overhead?

[Try the CLI instead](https://designmd.ai/cli) [Explore](https://designmd.ai/explore)