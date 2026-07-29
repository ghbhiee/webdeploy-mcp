import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const output = process.argv[2];
if (!output) throw new Error("Usage: node generate-jwks.mjs <output-file>");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const jwk = privateKey.export({ format: "jwk" });
writeFileSync(
  output,
  JSON.stringify({ keys: [{ ...jwk, kid: randomUUID(), use: "sig", alg: "RS256" }] }, null, 2),
  { mode: 0o600 },
);
