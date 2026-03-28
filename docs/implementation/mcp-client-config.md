# MCP Client Configuration

How to configure Claude Code to connect to the LL5 MCP servers.

---

## Config File

MCP servers are configured in `.mcp.json` at the project root (**not** in `.claude/settings.json`).

```json
{
  "mcpServers": {
    "personal-knowledge": {
      "type": "http",
      "url": "https://mcp-knowledge.noninoni.click/mcp",
      "headers": {
        "Authorization": "Bearer <API_KEY>"
      }
    },
    "gtd": {
      "type": "http",
      "url": "https://mcp-gtd.noninoni.click/mcp",
      "headers": {
        "Authorization": "Bearer <API_KEY>"
      }
    },
    "awareness": {
      "type": "http",
      "url": "https://mcp-awareness.noninoni.click/mcp",
      "headers": {
        "Authorization": "Bearer <API_KEY>"
      }
    }
  }
}
```

## Key Details

### Transport type must be `"http"`

Claude Code uses `"type": "http"` for remote MCP servers that use StreamableHTTPServerTransport. Do NOT use `"streamable-http"` or `"sse"` — those won't connect.

### Config goes in `.mcp.json`, NOT `.claude/settings.json`

- `.mcp.json` — MCP server connections (urls, auth headers)
- `.claude/settings.json` — permissions, hooks, project overrides

### Auto-approve MCP tools in settings

Add tool permissions in `.claude/settings.json` so Claude doesn't prompt for each MCP call:

```json
{
  "permissions": {
    "allow": [
      "mcp__personal-knowledge__*",
      "mcp__gtd__*",
      "mcp__awareness__*"
    ]
  }
}
```

### URL path is `/mcp`

All LL5 MCP servers expose the MCP protocol at the `/mcp` path. The health endpoint is at `/health`.

### Auth is Bearer token

All servers use the same API key passed as `Authorization: Bearer <key>` header.

### Verify connection

After configuring, run `claude mcp list` or `/mcp` inside Claude Code to check connection status. If servers show as disconnected, restart Claude Code (`exit` and relaunch).

## Reference: ll5-run workspace

The client workspace is at `/Users/arnon/workspace/ll5-run/` with:
- `.mcp.json` — MCP connections
- `.claude/settings.json` — permissions
- `.claude/skills/` — GTD workflow skills (/review, /daily, /clarify, /engage, /sweep, /plan)
- `CLAUDE.md` — GTD coaching personality and tool reference
