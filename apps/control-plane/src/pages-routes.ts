import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  AppError,
  PAGES_MAX_FILES_PER_PUBLISH,
  PAGES_MAX_FILE_BYTES,
  PAGES_MAX_PUBLISH_BYTES,
  PageService,
  pageSitePublicUrl,
  type Config,
  type PageSiteRecord,
} from "@webdeploy/core";

const publishSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      }),
    )
    .min(1)
    .max(PAGES_MAX_FILES_PER_PUBLISH),
  clean: z.boolean().default(false),
});

export function pageSiteSummary(config: Config, site: PageSiteRecord): Record<string, unknown> {
  return {
    slug: site.slug,
    name: site.name,
    publishedAt: site.publishedAt,
    createdAt: site.createdAt,
    publicUrl: pageSitePublicUrl(config.PUBLIC_URL, site.slug),
  };
}

export async function registerPagesRoutes(
  app: FastifyInstance,
  dependencies: { config: Config; pages: PageService },
): Promise<void> {
  const { config, pages } = dependencies;

  // Public, unauthenticated serving of every published site below one root:
  // GET /pages/<slug>/... maps to DATA_DIR/pages/<slug>/...
  await app.register(
    async (site) => {
      await site.register(fastifyStatic, {
        root: pages.pagesRoot,
        index: ["index.html"],
        dotfiles: "ignore",
        redirect: true,
        list: false,
        decorateReply: false,
      });
      site.addHook("onSend", async (request, reply) => {
        // Published pages are arbitrary user HTML; the dashboard CSP would
        // block their inline scripts and styles. Helmet writes to the raw
        // response, so remove the header there as well.
        reply.removeHeader("content-security-policy");
        reply.raw.removeHeader("content-security-policy");
        // Directory redirects are built from the proxy-stripped URL, so put
        // the public prefix (for example /webdeploy) back.
        const location = reply.getHeader("location");
        const prefix = request.headers["x-forwarded-prefix"];
        if (
          typeof location === "string" &&
          location.startsWith("/pages/") &&
          typeof prefix === "string" &&
          prefix &&
          prefix !== "/"
        ) {
          reply.header("location", `${prefix.replace(/\/+$/, "")}${location}`);
        }
      });
      site.setNotFoundHandler(async (_request, reply) =>
        reply.code(404).send({ error: { code: "NOT_FOUND", message: "Page not found" } }),
      );
    },
    { prefix: "/pages" },
  );

  // Token-authenticated publish API. Works with any HTTP client and needs no
  // OAuth or Passkey session.
  await app.register(
    async (api) => {
      api.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
        done(null, body),
      );

      const authenticate = async (request: FastifyRequest): Promise<PageSiteRecord> => {
        const header = String(request.headers.authorization ?? "");
        const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
        const token = bearer ?? String(request.headers["x-pages-token"] ?? "");
        if (!token) {
          throw new AppError(
            "PAGES_TOKEN_REQUIRED",
            "Provide the site publish token as an Authorization: Bearer header",
            401,
          );
        }
        return pages.authenticateToken(token);
      };

      api.get("/site", async (request) => {
        const site = await authenticate(request);
        return { site: pageSiteSummary(config, site) };
      });

      api.post(
        "/publish",
        { bodyLimit: Math.min(config.MAX_UPLOAD_BYTES, PAGES_MAX_PUBLISH_BYTES) },
        async (request) => {
          const site = await authenticate(request);
          const parsed = publishSchema.safeParse(request.body);
          if (!parsed.success) {
            throw new AppError("INVALID_PUBLISH_BODY", parsed.error.issues[0]?.message ?? "Invalid body");
          }
          const published = await pages.publishFiles(site, parsed.data.files, {
            clean: parsed.data.clean,
          });
          return { ...published, site: pageSiteSummary(config, site) };
        },
      );

      api.put(
        "/files/*",
        { bodyLimit: Math.min(config.MAX_UPLOAD_BYTES, PAGES_MAX_FILE_BYTES) },
        async (request) => {
          const site = await authenticate(request);
          const path = String((request.params as any)["*"] ?? "");
          const body = request.body;
          const content = Buffer.isBuffer(body)
            ? body
            : Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? ""), "utf8");
          const published = await pages.publishFiles(site, [{ path, content }]);
          return { ...published, path, site: pageSiteSummary(config, site) };
        },
      );

      api.delete("/files/*", async (request) => {
        const site = await authenticate(request);
        const path = String((request.params as any)["*"] ?? "");
        await pages.removeFile(site, path);
        return { deleted: path, site: pageSiteSummary(config, site) };
      });
    },
    { prefix: "/api/pages" },
  );
}
