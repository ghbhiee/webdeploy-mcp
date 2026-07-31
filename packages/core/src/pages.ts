import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Database } from "./db.js";
import { withTransaction } from "./db.js";
import { AppError, assertFound } from "./errors.js";
import { requireProjectAccess } from "./authorization.js";
import { hashToken, randomToken } from "./crypto.js";
import { writeAudit } from "./audit.js";
import type { Actor } from "./types.js";

export const PAGES_MAX_FILES_PER_PUBLISH = 200;
export const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const PAGES_MAX_PUBLISH_BYTES = 100 * 1024 * 1024;

export interface PageSiteRecord {
  id: string;
  ownerId: string;
  ownerUsername: string;
  slug: string;
  name: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PageSiteEntry {
  name: string;
  kind: "directory" | "file";
}

export interface PageFileInput {
  path: string;
  content: string | Buffer;
  encoding?: "utf8" | "base64";
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export function isValidPageSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function slugifyPageName(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function assertSafePagePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized
      .split("/")
      .some((segment) => segment === ".." || segment === "" || segment === ".") ||
    normalized.includes("\0")
  ) {
    throw new AppError("INVALID_PAGE_PATH", `Unsafe page file path: ${path}`);
  }
  return normalized;
}

export function pageSafeChild(root: string, ...segments: string[]): string {
  const absoluteRoot = resolve(root);
  const child = resolve(absoluteRoot, ...segments);
  const rel = relative(absoluteRoot, child);
  if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new AppError("INVALID_PAGE_PATH", `Resolved path escapes the pages root: ${child}`);
  }
  return child;
}

export function pageSitePublicUrl(publicUrl: string, slug: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/pages/${slug}/`;
}

function mapSite(row: any): PageSiteRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerUsername: row.owner_username,
    slug: row.slug,
    name: row.name,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_SITE = `
  SELECT s.*, u.username AS owner_username
  FROM page_sites s
  JOIN users u ON u.id = s.owner_id
`;

export class PageService {
  readonly pagesRoot: string;

  constructor(
    private readonly database: Database,
    dataDir: string,
  ) {
    this.pagesRoot = resolve(dataDir, "pages");
    mkdirSync(this.pagesRoot, { recursive: true });
    // A crash during a clean publish can leave swap directories behind.
    for (const entry of readdirSync(this.pagesRoot)) {
      if (entry.startsWith(".staging-") || entry.startsWith(".trash-")) {
        rmSync(resolve(this.pagesRoot, entry), { recursive: true, force: true });
      }
    }
  }

  siteRoot(slug: string): string {
    if (!isValidPageSlug(slug)) throw new AppError("INVALID_PAGE_SLUG", "Invalid pages site slug");
    return pageSafeChild(this.pagesRoot, slug);
  }

  async createSite(
    actor: Actor,
    input: { name?: string | undefined } = {},
  ): Promise<{ site: PageSiteRecord; token: string }> {
    const name = (input.name ?? actor.username).trim().slice(0, 120) || actor.username;
    const baseSlug = slugifyPageName(name) || "site";
    const token = `wdp_${randomToken(32)}`;
    const siteId = await withTransaction(this.database, async (client) => {
      let slug = isValidPageSlug(baseSlug) ? baseSlug : "site";
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const exists = await client.query("SELECT 1 FROM page_sites WHERE slug = $1", [slug]);
        if (!exists.rowCount) break;
        slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 48);
      }
      const result = await client.query(
        `INSERT INTO page_sites(owner_id, slug, name, token_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [actor.id, slug, name, hashToken(token)],
      );
      return result.rows[0].id as string;
    });
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "pages.site.create",
      targetType: "page_site",
      targetId: siteId,
      metadata: { name },
    });
    const site = await this.getById(siteId);
    await mkdir(this.siteRoot(site.slug), { recursive: true });
    return { site, token };
  }

  private async getById(siteId: string): Promise<PageSiteRecord> {
    const result = await this.database.query(`${SELECT_SITE} WHERE s.id = $1`, [siteId]);
    return mapSite(assertFound(result.rows[0], "Pages site not found"));
  }

  async listSites(actor: Actor): Promise<PageSiteRecord[]> {
    const result = actor.isAdmin
      ? await this.database.query(`${SELECT_SITE} ORDER BY s.created_at`)
      : await this.database.query(`${SELECT_SITE} WHERE s.owner_id = $1 ORDER BY s.created_at`, [
          actor.id,
        ]);
    return result.rows.map(mapSite);
  }

  async listEntries(actor: Actor, slug: string): Promise<PageSiteEntry[]> {
    const site = await this.getSite(actor, slug);
    const entries = await readdir(this.siteRoot(site.slug), { withFileTypes: true }).catch(
      () => [],
    );
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
      );
  }

  async getSite(actor: Actor, slug: string): Promise<PageSiteRecord> {
    const result = await this.database.query(`${SELECT_SITE} WHERE s.slug = $1`, [slug]);
    const site = assertFound(result.rows[0], "Pages site not found");
    requireProjectAccess(actor, site.owner_id);
    return mapSite(site);
  }

  async defaultSite(actor: Actor): Promise<{ site: PageSiteRecord; token?: string }> {
    const result = await this.database.query(
      `${SELECT_SITE} WHERE s.owner_id = $1 ORDER BY s.created_at LIMIT 1`,
      [actor.id],
    );
    if (result.rows[0]) return { site: mapSite(result.rows[0]) };
    return this.createSite(actor);
  }

  async authenticateToken(token: string): Promise<PageSiteRecord> {
    // The stored value is the SHA-256 of a 256-bit random token, so an
    // equality lookup on the hash is safe.
    const result = await this.database.query(`${SELECT_SITE} WHERE s.token_hash = $1`, [
      hashToken(token),
    ]);
    const site = result.rows[0];
    if (!site) throw new AppError("PAGES_TOKEN_INVALID", "Invalid pages publish token", 401);
    return mapSite(site);
  }

  async rotateToken(actor: Actor, slug: string): Promise<{ site: PageSiteRecord; token: string }> {
    const site = await this.getSite(actor, slug);
    const token = `wdp_${randomToken(32)}`;
    await this.database.query(
      "UPDATE page_sites SET token_hash = $2, updated_at = now() WHERE id = $1",
      [site.id, hashToken(token)],
    );
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "pages.site.token.rotate",
      targetType: "page_site",
      targetId: site.id,
    });
    return { site, token };
  }

  async deleteSite(actor: Actor, slug: string): Promise<void> {
    const site = await this.getSite(actor, slug);
    await this.database.query("DELETE FROM page_sites WHERE id = $1", [site.id]);
    await rm(this.siteRoot(site.slug), { recursive: true, force: true });
    await writeAudit(this.database, {
      actorUserId: actor.id,
      action: "pages.site.delete",
      targetType: "page_site",
      targetId: site.id,
      metadata: { slug: site.slug },
    });
  }

  async publishFiles(
    site: PageSiteRecord,
    files: PageFileInput[],
    options: { clean?: boolean } = {},
  ): Promise<{ fileCount: number; totalBytes: number }> {
    if (!files.length) throw new AppError("NO_PAGE_FILES", "At least one file is required");
    if (files.length > PAGES_MAX_FILES_PER_PUBLISH) {
      throw new AppError(
        "TOO_MANY_PAGE_FILES",
        `A single publish accepts at most ${PAGES_MAX_FILES_PER_PUBLISH} files`,
      );
    }
    const prepared = files.map((file) => ({
      path: assertSafePagePath(file.path),
      content: Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"),
    }));
    let totalBytes = 0;
    for (const file of prepared) {
      if (file.content.byteLength > PAGES_MAX_FILE_BYTES) {
        throw new AppError("PAGE_FILE_TOO_LARGE", `File ${file.path} exceeds the size limit`);
      }
      totalBytes += file.content.byteLength;
    }
    if (totalBytes > PAGES_MAX_PUBLISH_BYTES) {
      throw new AppError("PAGE_PUBLISH_TOO_LARGE", "Publish exceeds the total size limit");
    }
    const siteRoot = this.siteRoot(site.slug);
    if (options.clean) {
      const staging = pageSafeChild(this.pagesRoot, `.staging-${site.id}`);
      const trash = pageSafeChild(this.pagesRoot, `.trash-${site.id}`);
      await rm(staging, { recursive: true, force: true });
      await rm(trash, { recursive: true, force: true });
      for (const file of prepared) {
        const target = pageSafeChild(staging, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { mode: 0o644 });
      }
      if (
        await stat(siteRoot).then(
          () => true,
          () => false,
        )
      )
        await rename(siteRoot, trash);
      await rename(staging, siteRoot);
      await rm(trash, { recursive: true, force: true });
    } else {
      for (const file of prepared) {
        const target = pageSafeChild(siteRoot, file.path);
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.wdp-tmp`;
        await writeFile(temporary, file.content, { mode: 0o644 });
        await rename(temporary, target);
      }
    }
    await this.database.query(
      "UPDATE page_sites SET published_at = now(), updated_at = now() WHERE id = $1",
      [site.id],
    );
    return { fileCount: prepared.length, totalBytes };
  }

  async removeFile(site: PageSiteRecord, path: string): Promise<void> {
    const target = pageSafeChild(this.siteRoot(site.slug), assertSafePagePath(path));
    await rm(target, { recursive: true, force: true });
  }
}
