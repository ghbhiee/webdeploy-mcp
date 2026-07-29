export type McpAgentId = "codex" | "claude" | "generic";
export type McpInstallMethodId = "command" | "prompt" | "manual";

export interface McpInstallMethod {
  id: McpInstallMethodId;
  label: string;
  description: string;
  content: string;
  nextStep: string;
  fileName: string;
}

export interface McpInstallAgent {
  id: McpAgentId;
  label: string;
  description: string;
  methods: McpInstallMethod[];
}

export interface McpInstallCatalog {
  serverName: string;
  mcpUrl: string;
  agents: McpInstallAgent[];
}

const OAUTH_SCOPES = "openid,profile,platform:read,projects:write,deployments:write,offline_access";

export function deriveMcpServerName(publicMcpUrl: string): string {
  const url = new URL(publicMcpUrl);
  const identity = `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.toLowerCase();
  const slug = identity.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `webdeploy-${slug}`.slice(0, 64).replace(/-$/, "");
}

export function createMcpInstallCatalog(
  publicMcpUrl: string,
  configuredName?: string,
): McpInstallCatalog {
  const mcpUrl = `${publicMcpUrl.replace(/\/+$/, "")}/mcp`;
  const serverName = configuredName ?? deriveMcpServerName(publicMcpUrl);
  const codexCommand = `codex mcp add ${serverName} --url ${mcpUrl} --oauth-resource ${mcpUrl}
codex mcp login ${serverName} --scopes ${OAUTH_SCOPES}`;
  const claudeCommand = `claude mcp add --transport http --scope user ${serverName} ${mcpUrl}`;
  const basePrompt = `Server name: ${serverName}
MCP URL: ${mcpUrl}

Install it as a user-level remote Streamable HTTP MCP server. Use the client's native OAuth Authorization Code + PKCE flow; never ask me to paste an access token. Open the system browser for WebDeploy Passkey login and consent. Wait for me to approve access, then call "platform_status" and "list_projects" to verify the connection. Report the saved configuration location and verification result.`;

  return {
    serverName,
    mcpUrl,
    agents: [
      {
        id: "codex",
        label: "Codex",
        description: "OpenAI Codex CLI and Codex coding agents",
        methods: [
          {
            id: "command",
            label: "CLI command",
            description: "Copy both commands into a terminal.",
            content: codexCommand,
            nextStep: "The second command opens the browser. Complete Passkey login and consent.",
            fileName: `${serverName}-codex-command.txt`,
          },
          {
            id: "prompt",
            label: "Agent prompt",
            description: "Paste one prompt into Codex and let the agent configure itself.",
            content: `Install WebDeploy MCP in this Codex session.

${basePrompt}

Use these native commands:
${codexCommand}`,
            nextStep: "Keep the Agent session open while you complete browser authentication.",
            fileName: `${serverName}-codex-prompt.txt`,
          },
          {
            id: "manual",
            label: "Manual config",
            description: "Add this block to the Codex user configuration.",
            content: `# ~/.codex/config.toml
[mcp_servers.${serverName}]
url = "${mcpUrl}"
oauth_resource = "${mcpUrl}"`,
            nextStep: `Save the file, then run: codex mcp login ${serverName} --scopes ${OAUTH_SCOPES}`,
            fileName: `${serverName}-codex-manual.txt`,
          },
        ],
      },
      {
        id: "claude",
        label: "Claude Code",
        description: "Anthropic Claude Code CLI",
        methods: [
          {
            id: "command",
            label: "CLI command",
            description: "Copy the command into a terminal.",
            content: claudeCommand,
            nextStep: `Open Claude Code, enter /mcp, select ${serverName}, and choose Authenticate. Claude then opens the browser.`,
            fileName: `${serverName}-claude-command.txt`,
          },
          {
            id: "prompt",
            label: "Agent prompt",
            description: "Paste one prompt into Claude Code.",
            content: `Install WebDeploy MCP in this Claude Code session.

${basePrompt}

Run:
${claudeCommand}

Claude Code requires its interactive MCP screen for OAuth. After adding the server, tell me to enter "/mcp", select "${serverName}", and choose "Authenticate". Do not claim authentication is complete until the tools have been called successfully.`,
            nextStep: "Enter /mcp when Claude asks, then complete authentication in the browser.",
            fileName: `${serverName}-claude-prompt.txt`,
          },
          {
            id: "manual",
            label: "Manual config",
            description: "Add this server to the Claude Code user configuration.",
            content: `{
  "mcpServers": {
    "${serverName}": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`,
            nextStep: `Restart Claude Code, enter /mcp, select ${serverName}, and choose Authenticate.`,
            fileName: `${serverName}-claude-manual.txt`,
          },
        ],
      },
      {
        id: "generic",
        label: "Other Agent",
        description: "Any Agent with remote Streamable HTTP and OAuth support",
        methods: [
          {
            id: "prompt",
            label: "Agent prompt",
            description: "Paste one portable prompt into the Agent.",
            content: `Install the WebDeploy MCP server in this agent.

${basePrompt}

Detect this client's native MCP configuration and authentication commands. Do not use a stdio bridge. If authentication requires an interactive client screen that you cannot open, give me the single exact action required and continue verification afterward.`,
            nextStep: "Complete the browser prompt when it opens.",
            fileName: `${serverName}-agent-prompt.txt`,
          },
          {
            id: "manual",
            label: "Connection details",
            description: "Use these values in the Agent's MCP settings.",
            content: `Name: ${serverName}
Transport: Streamable HTTP
URL: ${mcpUrl}
Authentication: OAuth Authorization Code + PKCE
Token entry: Not required`,
            nextStep:
              "Start the client's OAuth action, complete Passkey login, and verify platform_status.",
            fileName: `${serverName}-connection.txt`,
          },
        ],
      },
    ],
  };
}

export function renderMcpInstallGuide(
  catalog: McpInstallCatalog,
  selection?: { agent?: McpAgentId; method?: McpInstallMethodId; raw?: boolean },
): string {
  const agents = selection?.agent
    ? catalog.agents.filter((agent) => agent.id === selection.agent)
    : catalog.agents;
  const sections = agents.flatMap((agent) => {
    const methods = selection?.method
      ? agent.methods.filter((method) => method.id === selection.method)
      : selection?.agent
        ? [agent.methods[0]!]
        : [
            agent.methods.find(
              (method) => method.id === (agent.id === "generic" ? "prompt" : "command"),
            )!,
          ];
    return methods.map((method) => ({ agent, method }));
  });

  if (!sections.length) {
    throw new Error("The selected installation method is not available for this Agent.");
  }
  if (selection?.raw) {
    if (sections.length !== 1) throw new Error("--raw requires one --agent selection.");
    return `${sections[0]!.method.content}\n`;
  }

  const body = sections
    .map(
      ({ agent, method }) => `## ${agent.label} — ${method.label}

${method.description}

\`\`\`text
${method.content}
\`\`\`

Next: ${method.nextStep}`,
    )
    .join("\n\n");
  return `# WebDeploy MCP installation

MCP name: ${catalog.serverName}
MCP endpoint: ${catalog.mcpUrl}

${body}

Run "webdeploy mcp --help" to select an Agent, method, raw output, or output file.
`;
}
