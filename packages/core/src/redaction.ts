const KEY_PATTERN =
  /(authorization|cookie|token|secret|password|passwd|private[_-]?key|api[_-]?key|session)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)=([^\s]+)/g;

export function redactText(input: string, knownSecrets: readonly string[] = []): string {
  let output = input.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  output = output.replace(ASSIGNMENT_PATTERN, "$1=[REDACTED]");
  for (const secret of knownSecrets) {
    if (secret.length >= 4) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        KEY_PATTERN.test(key) ? "[REDACTED]" : redactObject(child),
      ]),
    );
  }
  return value;
}
