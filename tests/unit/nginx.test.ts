import { describe, expect, it } from "vitest";
import { appDefaultPublicUrl } from "../../packages/core/src/config";
import { renderNginxAppLocation, renderNginxProject } from "../../apps/worker/src/nginx";

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

describe("Default app URL generation", () => {
  it("serves a dynamic project under the app base path with the prefix stripped", () => {
    const output = renderNginxAppLocation({
      appBasePath: "/apps",
      slug: "apple-health",
      projectId: "project",
      type: "python",
      currentPath: "/unused",
      port: 41000,
      spaFallback: false,
    });
    expect(output).toContain("location ^~ /apps/apple-health/ {");
    expect(output).toContain("proxy_pass http://127.0.0.1:41000/;");
    expect(output).toContain("proxy_set_header X-Forwarded-Prefix /apps/apple-health;");
    expect(output).toContain("return 308 /apps/apple-health/;");
  });

  it("serves a static project from its release directory with SPA fallback", () => {
    const output = renderNginxAppLocation({
      appBasePath: "/apps",
      slug: "site",
      projectId: "project",
      type: "static",
      currentPath: "/var/lib/webdeploy/projects/p/current",
      spaFallback: true,
    });
    expect(output).toContain("alias /var/lib/webdeploy/projects/p/current/;");
    expect(output).toContain("try_files $uri $uri/ /apps/site/index.html;");
    expect(output).not.toContain("proxy_pass");
  });

  it("requires a port for dynamic projects", () => {
    expect(() =>
      renderNginxAppLocation({
        appBasePath: "/apps",
        slug: "x",
        projectId: "project",
        type: "node",
        currentPath: "/unused",
        spaFallback: false,
      }),
    ).toThrow(/allocated port/);
  });

  it("builds the default public URL from the platform origin, not the base path", () => {
    expect(appDefaultPublicUrl("https://12.example.com/webdeploy", "/apps", "apple-health")).toBe(
      "https://12.example.com/apps/apple-health/",
    );
    expect(appDefaultPublicUrl("https://deploy.example.com", "/apps", "site")).toBe(
      "https://deploy.example.com/apps/site/",
    );
  });
});
