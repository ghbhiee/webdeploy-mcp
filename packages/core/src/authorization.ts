import type { Actor } from "./types.js";
import { AppError } from "./errors.js";

export function requireActive(actor: Actor): void {
  if (actor.status !== "active") {
    throw new AppError("ACCOUNT_INACTIVE", "The account is not active", 403);
  }
}

export function requireAdmin(actor: Actor): void {
  requireActive(actor);
  if (!actor.isAdmin) throw new AppError("ADMIN_REQUIRED", "Administrator access is required", 403);
}

export function requireProjectAccess(actor: Actor, ownerId: string): void {
  requireActive(actor);
  if (!actor.isAdmin && actor.id !== ownerId) {
    throw new AppError("PROJECT_ACCESS_DENIED", "You do not have access to this project", 403);
  }
}
