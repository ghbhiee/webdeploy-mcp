import { describe, expect, it } from "vitest";
import { loadConfig, publicBasePath, publicPath } from "../../packages/core/src/config";

describe("configuration", () => {
  it("uses the Dashboard origin as the MCP origin unless overridden", () => {
    const config = loadConfig({
      PUBLIC_URL: "https://deploy.example.com",
      DATABASE_URL: "postgresql://example",
    });
    expect(config.MCP_PUBLIC_URL).toBe("https://deploy.example.com");
    expect(config.MCP_SERVER_NAME).toBe("webdeploy-deploy-example-com");
  });

  it("rejects inverted port ranges", () => {
    expect(() =>
      loadConfig({
        PUBLIC_URL: "https://deploy.example.com",
        DATABASE_URL: "postgresql://example",
        PORT_RANGE_START: "42000",
        PORT_RANGE_END: "41000",
      }),
    ).toThrow(/PORT_RANGE_START/);
  });

  it("derives shared-domain paths for reverse proxy deployments", () => {
    expect(publicBasePath("https://12.tokencv.com/webdeploy/")).toBe("/webdeploy");
    expect(publicPath("https://12.tokencv.com/webdeploy", "/oauth/authorize")).toBe(
      "/webdeploy/oauth/authorize",
    );
  });
});
