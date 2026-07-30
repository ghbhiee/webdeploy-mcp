# Signed deployment webhooks

Each project can rotate a webhook secret in its Dashboard. The secret is displayed once, encrypted
at rest, and never returned by MCP.

Enable **Automatic deploy**, save a Git URL/ref, and send:

```http
POST /api/webhooks/projects/<project-id>
Content-Type: application/json
X-WebDeploy-Signature: sha256=<hex-hmac>

{"ref":"main"}
```

The signature is lowercase hex HMAC-SHA256 over the exact compact JSON representation. For the
example above:

```js
import { createHmac } from "node:crypto";

const body = JSON.stringify({ ref: "main" });
const signature = createHmac("sha256", process.env.WEBDEPLOY_WEBHOOK_SECRET)
  .update(body)
  .digest("hex");
```

Send `body` unchanged. Omit `ref` to deploy the project's configured Git ref. Failed signatures,
disabled users, missing Git configuration, and projects without auto deploy are rejected.

Provider-specific payload normalization is intentionally not part of v0.1.8. A small CI job or
webhook relay can translate a provider event into the compact payload above.
