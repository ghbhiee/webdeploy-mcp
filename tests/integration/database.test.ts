import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  PageService,
  ProjectService,
  createDatabase,
  migrate,
  type Actor,
} from "../../packages/core/src";

const connectionString = process.env.TEST_DATABASE_URL;
const describeDatabase = connectionString ? describe : describe.skip;

describeDatabase("PostgreSQL schema", () => {
  const database = createDatabase(connectionString!);

  beforeAll(async () => {
    await migrate(connectionString!, new URL("../../migrations", import.meta.url).pathname);
    await migrate(connectionString!, new URL("../../migrations", import.meta.url).pathname);
  });
  afterAll(async () => database.end());

  it("enforces project ownership and unique environment names", async () => {
    const user = (
      await database.query(
        `INSERT INTO users(username,webauthn_user_id,status)
         VALUES($1,$2,'active') RETURNING id`,
        [`test-${randomUUID()}`, Buffer.from(randomUUID())],
      )
    ).rows[0];
    const project = (
      await database.query(
        `INSERT INTO projects(owner_id,name,slug) VALUES($1,'Test',$2) RETURNING id`,
        [user.id, `test-${randomUUID()}`],
      )
    ).rows[0];
    await database.query("INSERT INTO project_settings(project_id) VALUES($1)", [project.id]);
    const rows = await database.query("SELECT owner_id FROM projects WHERE id=$1", [project.id]);
    expect(rows.rows[0].owner_id).toBe(user.id);
  });

  it("records migrations by full file name and remains idempotent", async () => {
    const expected = readdirSync(new URL("../../migrations", import.meta.url).pathname)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .map((file) => ({ version: file.replace(/\.sql$/, "") }))
      .sort((a, b) => a.version.localeCompare(b.version));
    expect(expected.length).toBeGreaterThan(0);
    const versions = await database.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(versions.rows).toEqual(expected);
  });

  it("allocates only one row per port", async () => {
    const users = await database.query("SELECT id FROM users LIMIT 1");
    const firstProject = (
      await database.query(
        `INSERT INTO projects(owner_id,name,slug) VALUES($1,'Port A',$2) RETURNING id`,
        [users.rows[0].id, `port-a-${randomUUID()}`],
      )
    ).rows[0];
    await database.query("INSERT INTO project_settings(project_id) VALUES($1)", [firstProject.id]);
    await database.query("INSERT INTO project_ports(port,project_id) VALUES(41990,$1)", [
      firstProject.id,
    ]);
    await expect(
      database.query("INSERT INTO project_ports(port,project_id) VALUES(41990,$1)", [
        firstProject.id,
      ]),
    ).rejects.toThrow();
  });

  it("enforces owner/admin access and never returns environment plaintext", async () => {
    const createActor = async (name: string, isAdmin = false): Promise<Actor> => {
      const user = (
        await database.query(
          `INSERT INTO users(username,webauthn_user_id,status,is_admin)
           VALUES($1,$2,'active',$3) RETURNING id`,
          [`${name}-${randomUUID()}`, Buffer.from(randomUUID()), isAdmin],
        )
      ).rows[0];
      return { id: user.id, username: name, isAdmin, status: "active" };
    };
    const owner = await createActor("owner");
    const stranger = await createActor("stranger");
    const admin = await createActor("admin", true);
    const projects = new ProjectService(database, Buffer.alloc(32, 7));
    const project = await projects.create(owner, { name: "Ownership Test", type: "static" });
    await projects.setEnvironment(owner, project.id, {
      name: "DATABASE_PASSWORD",
      value: "integration-secret-value",
      kind: "secret",
    });

    await expect(projects.get(stranger, project.id)).rejects.toMatchObject<AppError>({
      code: "PROJECT_ACCESS_DENIED",
    });
    await expect(projects.get(admin, project.id)).resolves.toMatchObject({ id: project.id });
    const metadata = await projects.listEnvironment(owner, project.id);
    expect(metadata).toEqual([
      expect.objectContaining({
        name: "DATABASE_PASSWORD",
        kind: "secret",
        isSet: true,
      }),
    ]);
    expect(JSON.stringify(metadata)).not.toContain("integration-secret-value");
  });

  it("runs the Pages site lifecycle with hashed tokens and safe directories", async () => {
    const user = (
      await database.query(
        `INSERT INTO users(username,webauthn_user_id,status)
         VALUES($1,$2,'active') RETURNING id,username`,
        [`pages-${randomUUID()}`, Buffer.from(randomUUID())],
      )
    ).rows[0];
    const owner: Actor = { id: user.id, username: user.username, isAdmin: false, status: "active" };
    const stranger: Actor = { ...owner, id: randomUUID(), username: "stranger" };
    const pages = new PageService(database, mkdtempSync(join(tmpdir(), "wdp-pages-")));

    const created = await pages.createSite(owner, { name: "Demo Site" });
    expect(created.token).toMatch(/^wdp_/);
    expect(created.site.slug).toMatch(/^demo-site/);
    const stored = await database.query("SELECT token_hash FROM page_sites WHERE id=$1", [
      created.site.id,
    ]);
    expect(stored.rows[0].token_hash).not.toContain(created.token);

    await expect(pages.authenticateToken(created.token)).resolves.toMatchObject({
      id: created.site.id,
    });
    await expect(pages.authenticateToken("wdp_wrong")).rejects.toMatchObject<AppError>({
      code: "PAGES_TOKEN_INVALID",
    });
    await expect(pages.getSite(stranger, created.site.slug)).rejects.toMatchObject<AppError>({
      code: "PROJECT_ACCESS_DENIED",
    });

    await pages.publishFiles(created.site, [
      { path: "index.html", content: "<h1>one</h1>" },
      { path: "assets/app.js", content: "Y29uc29sZQ==", encoding: "base64" },
    ]);
    const siteRoot = pages.siteRoot(created.site.slug);
    expect(readFileSync(join(siteRoot, "index.html"), "utf8")).toContain("one");
    await pages.publishFiles(created.site, [{ path: "only.html", content: "two" }], {
      clean: true,
    });
    expect(existsSync(join(siteRoot, "index.html"))).toBe(false);
    expect(readFileSync(join(siteRoot, "only.html"), "utf8")).toBe("two");
    await expect(
      pages.publishFiles(created.site, [{ path: "../escape.html", content: "x" }]),
    ).rejects.toMatchObject<AppError>({ code: "INVALID_PAGE_PATH" });

    const { site: defaulted } = await pages.defaultSite(owner);
    expect(defaulted.id).toBe(created.site.id);
    const rotated = await pages.rotateToken(owner, created.site.slug);
    await expect(pages.authenticateToken(created.token)).rejects.toMatchObject<AppError>({
      code: "PAGES_TOKEN_INVALID",
    });
    await expect(pages.authenticateToken(rotated.token)).resolves.toMatchObject({
      id: created.site.id,
    });

    await pages.deleteSite(owner, created.site.slug);
    expect(existsSync(siteRoot)).toBe(false);
    await expect(pages.getSite(owner, created.site.slug)).rejects.toMatchObject<AppError>({
      code: "NOT_FOUND",
    });
  });
});
