import { describe, expect, it } from "vitest";
import {
  createMcpInstallCatalog,
  renderMcpInstallGuide,
} from "../../packages/core/src/mcp-install";

describe("MCP installation instructions", () => {
  it("builds copy-ready choices for Codex, Claude, and generic Agents", () => {
    const catalog = createMcpInstallCatalog("https://mcp.example.com/");

    expect(catalog.mcpUrl).toBe("https://mcp.example.com/mcp");
    expect(catalog.agents.map((agent) => agent.id)).toEqual(["codex", "claude", "generic"]);
    expect(catalog.agents[0]?.methods.map((method) => method.id)).toEqual([
      "command",
      "prompt",
      "manual",
    ]);
    expect(catalog.agents[1]?.methods[0]?.content).toContain(
      "claude mcp add --transport http --scope user webdeploy",
    );
  });

  it("renders a selected raw method and a complete default guide", () => {
    const catalog = createMcpInstallCatalog("https://mcp.example.com");
    const raw = renderMcpInstallGuide(catalog, {
      agent: "codex",
      method: "command",
      raw: true,
    });
    const guide = renderMcpInstallGuide(catalog);

    expect(raw).toContain("codex mcp login webdeploy");
    expect(guide).toContain("## Codex");
    expect(guide).toContain("## Claude Code");
    expect(guide).toContain("## Other Agent");
    expect(guide).toContain("webdeploy mcp --help");
  });

  it("rejects unavailable Agent and method combinations", () => {
    const catalog = createMcpInstallCatalog("https://mcp.example.com");
    expect(() => renderMcpInstallGuide(catalog, { agent: "generic", method: "command" })).toThrow(
      "not available",
    );
  });
});
