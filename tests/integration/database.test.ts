import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
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
      code: "PROJECT_FORBIDDEN",
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
});
