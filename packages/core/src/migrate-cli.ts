import { resolve } from "node:path";
import { migrate } from "./migrate.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

await migrate(connectionString, resolve(process.cwd(), "migrations"));
console.log("Database migrations completed.");
