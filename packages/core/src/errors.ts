export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function assertFound<T>(value: T | null | undefined, message = "Resource not found"): T {
  if (value == null) throw new AppError("NOT_FOUND", message, 404);
  return value;
}
