import { describe, expect, it } from "vitest";
import { renderNginxProject } from "../../apps/worker/src/nginx";

describe("Nginx generation", () => {
  it("generates a static SPA server without interpolating shell values", () => {
    const output = renderNginxProject({
      hostname: "site.example.com",
      projectId: "project",
      type: "static",
      currentPath: "/srv/project/current",
      spaFallback: true,
    });
    expect(output).toContain("server_name site.example.com;");
    expect(output).toContain("try_files $uri $uri/ /index.html;");
    expect(output).not.toContain("proxy_pass");
  });

  it("binds dynamic upstreams only to loopback", () => {
    const output = renderNginxProject({
      hostname: "api.example.com",
      projectId: "project",
      type: "node",
      currentPath: "/unused",
      port: 41001,
      spaFallback: false,
    });
    expect(output).toContain("proxy_pass http://127.0.0.1:41001;");
  });
});
