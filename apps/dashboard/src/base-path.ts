export const basePath = import.meta.env.BASE_URL.replace(/\/+$/, "");

export function toPublicPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${normalized}` || "/";
}

export function toAppPath(pathname: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length) || "/";
  return pathname;
}

export function safeReturnPath(value: string | null): string {
  if (!value || value.startsWith("//")) return toPublicPath("/");
  if (!basePath) return value.startsWith("/") ? value : "/";
  return value === basePath || value.startsWith(`${basePath}/`) ? value : toPublicPath("/");
}
