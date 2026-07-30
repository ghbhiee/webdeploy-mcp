import { describe, expect, it } from "vitest";
import { responseErrorMessage } from "../../apps/dashboard/src/api.js";

describe("dashboard API errors", () => {
  it("reads the control-plane error envelope", () => {
    expect(
      responseErrorMessage(
        {
          error: {
            code: "LOGIN_FAILED",
            message: "No active account matches that identifier",
          },
        },
        401,
      ),
    ).toBe("No active account matches that identifier");
  });

  it("also reads Fastify's default error response", () => {
    expect(
      responseErrorMessage(
        {
          statusCode: 401,
          code: "LOGIN_FAILED",
          error: "Unauthorized",
          message: "No active account matches that identifier",
        },
        401,
      ),
    ).toBe("No active account matches that identifier");
  });

  it("falls back to the HTTP status for an unknown response", () => {
    expect(responseErrorMessage({}, 502)).toBe("Request failed with HTTP 502");
  });
});
