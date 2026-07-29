export type UserStatus = "pending" | "active" | "disabled";
export type ProjectType = "static" | "node" | "python";
export type SourceKind = "git" | "archive" | "inline";
export type DeploymentStatus =
  | "queued"
  | "preparing"
  | "fetching"
  | "installing"
  | "building"
  | "starting_candidate"
  | "health_checking"
  | "activating"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Actor {
  id: string;
  username: string;
  isAdmin: boolean;
  status: UserStatus;
}

export interface ProjectSettings {
  gitUrl?: string | null;
  gitRef: string;
  installCommand?: string | null;
  buildCommand?: string | null;
  outputDirectory?: string | null;
  startCommand?: string | null;
  servicePort?: number | null;
  healthCheckPath: string;
  spaFallback: boolean;
  nodeVersion?: string | null;
  pythonVersion?: string | null;
  autoDeploy: boolean;
  releaseRetention: number;
}
