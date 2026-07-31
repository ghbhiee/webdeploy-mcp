import { useCallback, useEffect, useState, type FormEvent } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api, setCsrf, type McpInstallCatalog, type McpInstallMethod, type Session } from "./api";
import { safeReturnPath, toAppPath, toPublicPath } from "./base-path";

type Project = {
  id: string;
  name: string;
  slug: string;
  type: "static" | "node" | "python";
  status: string;
  ownerUsername: string;
  primaryHostname: string | null;
  primaryDomainVerified?: boolean;
  publicUrl?: string;
  settings: Record<string, any>;
};

type DatabaseInfo = {
  dbName: string;
  status: "provisioning" | "provisioned" | "failed";
  errorMessage: string | null;
  provisionedAt: string | null;
} | null;

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [path, setPath] = useState(() => toAppPath(location.pathname));
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const navigate = useCallback((next: string) => {
    history.pushState({}, "", toPublicPath(next));
    setPath(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const onPop = () => setPath(toAppPath(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    api<Session>("/api/auth/session")
      .then((value) => {
        setSession(value);
        setCsrf(value.csrfToken);
      })
      .catch(() => setSession({ authenticated: false }));
  }, []);

  const show = useCallback((kind: "error" | "success", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 6000);
  }, []);

  if (!session) return <Loading />;
  if (!session.authenticated) {
    return path === "/register" ? (
      <RegisterPage navigate={navigate} show={show} notice={notice} />
    ) : (
      <LoginPage
        navigate={navigate}
        show={show}
        notice={notice}
        onAuthenticated={async () => {
          const value = await api<Session>("/api/auth/session");
          setSession(value);
          setCsrf(value.csrfToken);
          const returnTo = new URLSearchParams(location.search).get("returnTo");
          location.assign(safeReturnPath(returnTo));
        }}
      />
    );
  }

  const projectMatch = path.match(/^\/projects\/([0-9a-f-]+)(?:\/setup)?$/);
  return (
    <Shell
      user={session.user!}
      navigate={navigate}
      path={path}
      onLogout={async () => {
        await api("/api/auth/logout", { method: "POST" });
        setSession({ authenticated: false });
        setCsrf();
        navigate("/login");
      }}
    >
      {notice && <Notice {...notice} />}
      {projectMatch ? (
        <ProjectPage
          projectId={projectMatch[1]!}
          isAdmin={Boolean(session.user?.isAdmin)}
          show={show}
        />
      ) : path === "/admin" && session.user?.isAdmin ? (
        <AdminPage show={show} />
      ) : (
        <ProjectsPage navigate={navigate} show={show} mcpInstall={session.mcpInstall} />
      )}
    </Shell>
  );
}

function Shell({
  user,
  children,
  navigate,
  path,
  onLogout,
}: {
  user: NonNullable<Session["user"]>;
  children: React.ReactNode;
  navigate: (path: string) => void;
  path: string;
  onLogout: () => void;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("/")} aria-label="WebDeploy home">
          <span className="brand-mark">W</span>
          <span>WebDeploy</span>
        </button>
        <nav aria-label="Primary navigation">
          <button className={path === "/" ? "active" : ""} onClick={() => navigate("/")}>
            Projects
          </button>
          {user.isAdmin && (
            <button
              className={path === "/admin" ? "active" : ""}
              onClick={() => navigate("/admin")}
            >
              Administration
            </button>
          )}
        </nav>
        <div className="sidebar-user">
          <div className="avatar">{user.username.slice(0, 1).toUpperCase()}</div>
          <div>
            <strong>{user.username}</strong>
            <small>{user.isAdmin ? "Administrator" : "Member"}</small>
          </div>
          <button className="text-button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function ProjectsPage({
  navigate,
  show,
  mcpInstall,
}: {
  navigate: (path: string) => void;
  show: (kind: "error" | "success", text: string) => void;
  mcpInstall?: McpInstallCatalog;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      const value = await api<{ projects: Project[] }>("/api/projects");
      setProjects(value.projects);
    } catch (error) {
      show("error", message(error));
    } finally {
      setLoading(false);
    }
  }, [show]);
  useEffect(() => void load(), [load]);
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Control plane</p>
          <h1>Projects</h1>
          <p>Build, release, and roll back sites without coupling them to a hosting vendor.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          New project
        </button>
      </header>
      {mcpInstall ? <McpInstallPanel catalog={mcpInstall} show={show} /> : null}
      {loading ? (
        <Loading />
      ) : projects.length ? (
        <section className="project-grid" aria-label="Projects">
          {projects.map((project) => (
            <button
              className="project-card"
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}/setup`)}
            >
              <div className="project-card-top">
                <span className={`status-dot ${project.status}`} />
                <span className="pill">{project.type}</span>
              </div>
              <h2>{project.name}</h2>
              <p>{project.slug}</p>
              {project.publicUrl && (
                <span
                  className="live-link"
                  role="link"
                  title={project.publicUrl}
                  onClick={(event) => {
                    event.stopPropagation();
                    window.open(project.publicUrl, "_blank", "noopener");
                  }}
                >
                  {project.publicUrl.replace(/^https?:\/\//, "")} ↗
                </span>
              )}
              <div className="project-card-footer">
                <span>{project.ownerUsername}</span>
                <strong>{project.status}</strong>
              </div>
            </button>
          ))}
        </section>
      ) : (
        <EmptyState onCreate={() => setCreating(true)} />
      )}
      {creating && (
        <Modal title="Create a project" onClose={() => setCreating(false)}>
          <ProjectCreateForm
            onCreated={(project) => {
              setCreating(false);
              navigate(`/projects/${project.id}/setup`);
            }}
            show={show}
          />
        </Modal>
      )}
    </>
  );
}

function McpInstallPanel({
  catalog,
  show,
}: {
  catalog: McpInstallCatalog;
  show: (kind: "error" | "success", text: string) => void;
}) {
  const [agentId, setAgentId] = useState(catalog.agents[0]!.id);
  const [methodId, setMethodId] = useState(catalog.agents[0]!.methods[0]!.id);
  const agent = catalog.agents.find((candidate) => candidate.id === agentId) ?? catalog.agents[0]!;
  const method = agent.methods.find((candidate) => candidate.id === methodId) ?? agent.methods[0]!;

  return (
    <section className="mcp-install-panel" aria-labelledby="mcp-install-title">
      <div className="mcp-install-heading">
        <div>
          <p className="eyebrow">AI connection</p>
          <h2 id="mcp-install-title">Install WebDeploy MCP</h2>
          <p>Select your Agent and method, then copy one ready-to-use block.</p>
        </div>
        <span className="protocol-badge">MCP · OAuth</span>
      </div>

      <div className="mcp-install-controls">
        <label>
          Agent
          <select
            aria-label="Agent"
            value={agent.id}
            onChange={(event) => {
              const nextAgent =
                catalog.agents.find((candidate) => candidate.id === event.target.value) ??
                catalog.agents[0]!;
              setAgentId(nextAgent.id);
              setMethodId(nextAgent.methods[0]!.id);
            }}
          >
            {catalog.agents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
          <small>{agent.description}</small>
        </label>
        <label>
          Installation method
          <select
            aria-label="Installation method"
            value={method.id}
            onChange={(event) => setMethodId(event.target.value as McpInstallMethod["id"])}
          >
            {agent.methods.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
          <small>{method.description}</small>
        </label>
      </div>

      <div className="mcp-selected-install">
        <div className="mcp-selected-heading">
          <div>
            <span className="client-index">READY</span>
            <h3>
              {agent.label} · {method.label}
            </h3>
          </div>
          <div className="mcp-selected-meta">
            <code>{catalog.serverName}</code>
            <code>{catalog.mcpUrl}</code>
          </div>
        </div>
        <CopyBlock
          label={`Copy ${agent.label} ${method.label}`}
          value={method.content}
          downloadValue={`WebDeploy MCP installation

Agent: ${agent.label}
Method: ${method.label}
MCP name: ${catalog.serverName}
MCP endpoint: ${catalog.mcpUrl}

${method.content}

Next: ${method.nextStep}
`}
          fileName={method.fileName}
          show={show}
          large
        />
        <p className="mcp-next-step">
          <strong>Next:</strong> {method.nextStep}
        </p>
      </div>
    </section>
  );
}

function CopyBlock({
  label,
  value,
  downloadValue,
  fileName,
  show,
  large = false,
}: {
  label: string;
  value: string;
  downloadValue?: string;
  fileName?: string;
  show: (kind: "error" | "success", text: string) => void;
  large?: boolean;
}) {
  return (
    <div className={`copy-block${large ? " large" : ""}`}>
      <pre>
        <code>{value}</code>
      </pre>
      <div className="copy-actions">
        <button
          type="button"
          aria-label={label}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              show("success", "Copied. Paste it into your terminal or Agent.");
            } catch {
              show("error", "Clipboard access failed. Select and copy the text manually.");
            }
          }}
        >
          Copy
        </button>
        {fileName ? (
          <button
            type="button"
            aria-label={`Download ${fileName}`}
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([downloadValue ?? `${value}\n`], { type: "text/plain" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = fileName;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ProjectCreateForm({
  onCreated,
  show,
}: {
  onCreated: (project: Project) => void;
  show: (kind: "error" | "success", text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const response = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: data.get("name"), type: data.get("type") }),
      });
      onCreated(response.project);
    } catch (error) {
      show("error", message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="form-stack">
      <label>
        Project name
        <input name="name" required maxLength={120} autoFocus />
      </label>
      <label>
        Runtime
        <select name="type" defaultValue="static">
          <option value="static">Static / built frontend</option>
          <option value="node">Node.js service</option>
          <option value="python">Python service</option>
        </select>
      </label>
      <button className="primary" disabled={busy}>
        {busy ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}

function ProjectPage({
  projectId,
  isAdmin,
  show,
}: {
  projectId: string;
  isAdmin: boolean;
  show: (kind: "error" | "success", text: string) => void;
}) {
  const [data, setData] = useState<{
    project: Project;
    environment: Array<any>;
    releases: Array<any>;
    databaseInfo?: DatabaseInfo;
  } | null>(null);
  const [tab, setTab] = useState<"settings" | "environment" | "releases">("settings");
  const [deployment, setDeployment] = useState<any>(null);
  const [logs, setLogs] = useState<Array<any>>([]);
  const [uploading, setUploading] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api(`/api/projects/${projectId}`));
    } catch (error) {
      show("error", message(error));
    }
  }, [projectId, show]);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!deployment?.id || ["succeeded", "failed"].includes(deployment.status)) return;
    const timer = setInterval(async () => {
      const status = await api<any>(`/api/deployments/${deployment.id}`);
      setDeployment(status.deployment);
      const logData = await api<any>(`/api/deployments/${deployment.id}/logs?limit=500`);
      setLogs(logData.logs);
      if (["succeeded", "failed"].includes(status.deployment.status)) void load();
    }, 1500);
    return () => clearInterval(timer);
  }, [deployment?.id, deployment?.status, load]);

  if (!data) return <Loading />;
  return (
    <>
      <header className="page-header compact">
        <div>
          <p className="eyebrow">
            {data.project.ownerUsername} / {data.project.slug}
          </p>
          <h1>{data.project.name}</h1>
          <p>
            <span className={`status-dot ${data.project.status}`} /> {data.project.status}
          </p>
          {data.project.publicUrl && (
            <p>
              <a
                className="live-link"
                href={data.project.publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                {data.project.publicUrl} ↗
              </a>
            </p>
          )}
        </div>
        <button
          className="primary"
          onClick={async () => {
            try {
              const result = await api<{ deploymentId: string }>(
                `/api/projects/${projectId}/deploy`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    sourceKind: "git",
                    sourceSpec: {
                      url: data.project.settings.gitUrl,
                      ref: data.project.settings.gitRef,
                    },
                  }),
                },
              );
              setDeployment({ id: result.deploymentId, status: "queued" });
              setLogs([]);
            } catch (error) {
              show("error", message(error));
            }
          }}
          disabled={!data.project.settings.gitUrl}
        >
          Deploy now
        </button>
      </header>
      {deployment && (
        <section className="deployment-banner">
          <div>
            <span className="pulse" />
            <strong>{deployment.status}</strong>
            <small>{deployment.id}</small>
          </div>
          {logs.length > 0 && (
            <pre className="log-viewer">{logs.map((entry) => entry.message).join("")}</pre>
          )}
        </section>
      )}
      <section className="source-actions panel">
        <div>
          <h2>Deploy an archive</h2>
          <p>Upload ZIP, TAR, TAR.GZ, or TGZ. The current release stays live until checks pass.</p>
        </div>
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const body = new FormData(form);
            try {
              setUploading(true);
              const result = await api<{ deploymentId: string }>(
                `/api/projects/${projectId}/upload`,
                { method: "POST", body },
              );
              setDeployment({ id: result.deploymentId, status: "queued" });
              setLogs([]);
              form.reset();
            } catch (error) {
              show("error", message(error));
            } finally {
              setUploading(false);
            }
          }}
        >
          <input
            name="file"
            type="file"
            accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/x-tar"
            required
          />
          <button disabled={uploading}>{uploading ? "Uploading…" : "Upload and deploy"}</button>
        </form>
      </section>
      <div className="tabs" role="tablist">
        {(["settings", "environment", "releases"] as const).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "active" : ""}
            onClick={() => setTab(name)}
          >
            {title(name)}
          </button>
        ))}
      </div>
      {tab === "settings" ? (
        <>
          <SettingsForm project={data.project} isAdmin={isAdmin} onSaved={load} show={show} />
          <DatabasePanel
            projectId={projectId}
            info={data.databaseInfo ?? null}
            onChanged={load}
            show={show}
          />
        </>
      ) : tab === "environment" ? (
        <EnvironmentPanel
          projectId={projectId}
          variables={data.environment}
          onChanged={load}
          show={show}
        />
      ) : (
        <ReleasesPanel
          projectId={projectId}
          releases={data.releases}
          onChanged={load}
          show={show}
        />
      )}
    </>
  );
}

function DatabasePanel({
  projectId,
  info,
  onChanged,
  show,
}: {
  projectId: string;
  info: DatabaseInfo;
  onChanged: () => void;
  show: (kind: "error" | "success", text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (info?.status !== "provisioning") return;
    const timer = setInterval(onChanged, 2000);
    return () => clearInterval(timer);
  }, [info?.status, onChanged]);
  const provision = async () => {
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/database`, { method: "POST" });
      show("success", "Database provisioning queued.");
      onChanged();
    } catch (error) {
      show("error", message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>Database</h2>
      {!info ? (
        <>
          <p>
            No database yet. Provisioning creates a dedicated PostgreSQL database on this host and
            injects its connection string as the <code>DATABASE_URL</code> secret environment
            variable.
          </p>
          <button className="primary" onClick={provision} disabled={busy}>
            {busy ? "Queueing…" : "Provision database"}
          </button>
        </>
      ) : info.status === "provisioned" ? (
        <p>
          <span className="pill">provisioned</span> <code>{info.dbName}</code> — available to the
          app as <code>DATABASE_URL</code> (secret, write-only). Deploy or restart to apply.
        </p>
      ) : info.status === "provisioning" ? (
        <p>
          <span className="pill">provisioning…</span> This normally completes within seconds.
        </p>
      ) : (
        <>
          <p>
            <span className="pill">failed</span> {info.errorMessage}
          </p>
          <button className="primary" onClick={provision} disabled={busy}>
            {busy ? "Queueing…" : "Retry provisioning"}
          </button>
        </>
      )}
    </section>
  );
}

function SettingsForm({
  project,
  isAdmin,
  onSaved,
  show,
}: {
  project: Project;
  isAdmin: boolean;
  onSaved: () => void;
  show: (kind: "error" | "success", text: string) => void;
}) {
  const s = project.settings;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: data.name,
          type: data.type,
          gitUrl: data.gitUrl || null,
          gitRef: data.gitRef || "main",
          installCommand: data.installCommand || null,
          buildCommand: data.buildCommand || null,
          outputDirectory: data.outputDirectory || null,
          startCommand: data.startCommand || null,
          servicePort: data.servicePort ? Number(data.servicePort) : null,
          healthCheckPath: data.healthCheckPath || "/",
          spaFallback: data.spaFallback === "on",
          nodeVersion: data.nodeVersion || null,
          pythonVersion: data.pythonVersion || null,
          autoDeploy: data.autoDeploy === "on",
          releaseRetention: Number(data.releaseRetention || 5),
        }),
      });
      if (data.hostname) {
        await api(`/api/projects/${project.id}/domain`, {
          method: "POST",
          body: JSON.stringify({ hostname: data.hostname }),
        });
      }
      show("success", "Settings saved.");
      onSaved();
    } catch (error) {
      show("error", message(error));
    }
  };
  return (
    <form className="settings-grid" onSubmit={submit}>
      <section className="panel">
        <h2>Project</h2>
        <label>
          Name
          <input name="name" defaultValue={project.name} required />
        </label>
        <label>
          Type
          <select name="type" defaultValue={project.type}>
            <option value="static">Static / frontend</option>
            <option value="node">Node.js</option>
            <option value="python">Python</option>
          </select>
        </label>
        <label>
          Custom domain
          <input
            name="hostname"
            defaultValue={project.primaryHostname ?? ""}
            placeholder="www.example.com"
            inputMode="url"
          />
        </label>
        {project.primaryHostname && !project.primaryDomainVerified && (
          <p className="field-hint">
            DNS for {project.primaryHostname} does not point at this server yet, so the default app
            URL stays active. Add the DNS record, then save again to re-verify.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Source</h2>
        <label>
          Git repository
          <input
            name="gitUrl"
            defaultValue={s.gitUrl ?? ""}
            placeholder="https://github.com/owner/repo.git"
          />
        </label>
        <label>
          Branch, tag, or commit
          <input name="gitRef" defaultValue={s.gitRef ?? "main"} />
        </label>
      </section>
      <section className="panel wide">
        <h2>Build and runtime</h2>
        <div className="two-column">
          <label>
            Install command
            <input
              name="installCommand"
              defaultValue={s.installCommand ?? ""}
              placeholder="pnpm install --frozen-lockfile"
            />
          </label>
          <label>
            Build command
            <input
              name="buildCommand"
              defaultValue={s.buildCommand ?? ""}
              placeholder="pnpm build"
            />
          </label>
          <label>
            Output directory
            <input
              name="outputDirectory"
              defaultValue={s.outputDirectory ?? ""}
              placeholder="dist"
            />
          </label>
          <label>
            Start command
            <input
              name="startCommand"
              defaultValue={s.startCommand ?? ""}
              placeholder="node dist/index.js"
            />
          </label>
          <label>
            Health check path
            <input name="healthCheckPath" defaultValue={s.healthCheckPath ?? "/"} />
          </label>
          <label>
            Preferred service port
            <input
              name="servicePort"
              type="number"
              min="1024"
              max="65535"
              defaultValue={s.servicePort ?? ""}
              placeholder="Automatically assigned"
            />
          </label>
          <label>
            Releases to retain
            <input
              name="releaseRetention"
              type="number"
              min="1"
              max="50"
              defaultValue={s.releaseRetention ?? 5}
            />
          </label>
          <label>
            Node.js version
            <input name="nodeVersion" defaultValue={s.nodeVersion ?? ""} placeholder="24" />
          </label>
          <label>
            Python version
            <input name="pythonVersion" defaultValue={s.pythonVersion ?? ""} placeholder="3.13" />
          </label>
        </div>
        <div className="checks">
          <label>
            <input type="checkbox" name="spaFallback" defaultChecked={s.spaFallback} /> SPA fallback
          </label>
          <label>
            <input type="checkbox" name="autoDeploy" defaultChecked={s.autoDeploy} /> Automatic
            deploy
          </label>
        </div>
        <div className="webhook-box">
          <div>
            <strong>Signed deploy webhook</strong>
            <p>
              POST JSON to <code>/api/webhooks/projects/{project.id}</code> with an
              <code> X-WebDeploy-Signature: sha256=&lt;HMAC&gt;</code> header.
            </p>
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                const result = await api<{ secret: string }>(
                  `/api/projects/${project.id}/webhook-secret`,
                  { method: "POST" },
                );
                show("success", `Webhook secret (shown once): ${result.secret}`);
              } catch (error) {
                show("error", message(error));
              }
            }}
          >
            Rotate secret
          </button>
        </div>
      </section>
      {isAdmin && (
        <section className="panel">
          <h2>Ownership</h2>
          <p>Transfer this project by entering the destination user ID from Administration.</p>
          <div className="inline-form">
            <input id="new-owner-id" placeholder="User UUID" />
            <button
              type="button"
              onClick={async () => {
                const ownerId = (
                  document.querySelector("#new-owner-id") as HTMLInputElement
                ).value.trim();
                if (!ownerId) return;
                try {
                  await api(`/api/projects/${project.id}/transfer`, {
                    method: "POST",
                    body: JSON.stringify({ ownerId }),
                  });
                  show("success", "Project ownership transferred.");
                  onSaved();
                } catch (error) {
                  show("error", message(error));
                }
              }}
            >
              Transfer
            </button>
          </div>
        </section>
      )}
      <button className="primary save-button">Save settings</button>
    </form>
  );
}

function EnvironmentPanel({ projectId, variables, onChanged, show }: any) {
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api(
        `/api/projects/${projectId}/environment/${encodeURIComponent(String(data.get("name")))}`,
        {
          method: "PUT",
          body: JSON.stringify({ value: data.get("value"), kind: data.get("kind") }),
        },
      );
      form.reset();
      show("success", "Environment variable stored. Its value will not be shown again.");
      onChanged();
    } catch (error) {
      show("error", message(error));
    }
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Environment</h2>
          <p>Values are encrypted. MCP clients can see names and status, never values.</p>
        </div>
      </div>
      <form className="inline-form" onSubmit={submit}>
        <input name="name" placeholder="VARIABLE_NAME" pattern="[A-Za-z_][A-Za-z0-9_]*" required />
        <input name="value" type="password" placeholder="Value" autoComplete="off" required />
        <select name="kind">
          <option value="secret">Secret</option>
          <option value="plain">Plain</option>
        </select>
        <button className="primary">Add</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Value</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {variables.map((item: any) => (
              <tr key={item.name}>
                <td>
                  <code>{item.name}</code>
                </td>
                <td>{item.kind}</td>
                <td>••••••••</td>
                <td>{date(item.updatedAt)}</td>
                <td>
                  <button
                    className="danger-link"
                    onClick={async () => {
                      await api(
                        `/api/projects/${projectId}/environment/${encodeURIComponent(item.name)}`,
                        { method: "DELETE" },
                      );
                      onChanged();
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReleasesPanel({ projectId, releases, onChanged, show }: any) {
  return (
    <section className="panel">
      <h2>Release history</h2>
      <div className="release-list">
        {releases.map((release: any) => (
          <article className="release-row" key={release.id}>
            <div>
              <strong>Release #{release.sequence}</strong>
              <small>
                {release.sourceRevision?.slice(0, 12) || "uploaded source"} ·{" "}
                {date(release.createdAt)}
              </small>
            </div>
            <span className={`pill ${release.status}`}>{release.status}</span>
            {release.status === "inactive" && (
              <button
                onClick={async () => {
                  try {
                    await api(`/api/projects/${projectId}/releases/${release.id}/rollback`, {
                      method: "POST",
                    });
                    show("success", "Rollback queued.");
                    onChanged();
                  } catch (error) {
                    show("error", message(error));
                  }
                }}
              >
                Rollback
              </button>
            )}
          </article>
        ))}
      </div>
      {!releases.length && <p className="muted">No successful releases yet.</p>}
    </section>
  );
}

function AdminPage({ show }: { show: (kind: "error" | "success", text: string) => void }) {
  const [users, setUsers] = useState<Array<any>>([]);
  const [pending, setPending] = useState<Array<any>>([]);
  const load = useCallback(async () => {
    const [u, p] = await Promise.all([
      api<{ users: any[] }>("/api/admin/users"),
      api<{ pending: any[] }>("/api/admin/passkeys/pending"),
    ]);
    setUsers(u.users);
    setPending(p.pending);
  }, []);
  useEffect(() => {
    void load().catch((error) => show("error", message(error)));
  }, [load, show]);
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Security</p>
          <h1>Administration</h1>
          <p>Approve identities, manage roles, and disable access.</p>
        </div>
      </header>
      <section className="panel">
        <h2>Pending Passkeys</h2>
        {pending.map((item) => (
          <article className="approval-row" key={item.id}>
            <div>
              <strong>{item.email}</strong>
              <small>
                {item.user_status === "active" ? "Additional Passkey" : "New user"} ·{" "}
                {item.passkey_name || "Passkey"} · <code>{item.request_code}</code>
              </small>
            </div>
            <button
              className="primary"
              onClick={async () => {
                await api(`/api/admin/passkeys/${item.request_code}/approve`, { method: "POST" });
                show("success", `Approved ${item.email}.`);
                load();
              }}
            >
              Approve
            </button>
            <button
              className="danger-link"
              onClick={async () => {
                await api(`/api/admin/passkeys/${item.request_code}/reject`, { method: "POST" });
                show("success", `Rejected ${item.email}.`);
                load();
              }}
            >
              Reject
            </button>
          </article>
        ))}
        {!pending.length && <p className="muted">No pending requests.</p>}
      </section>
      <section className="panel">
        <h2>Users</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Role</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.email}</strong>
                  </td>
                  <td>{user.status}</td>
                  <td>{user.is_admin ? "Administrator" : "Member"}</td>
                  <td>{date(user.created_at)}</td>
                  <td className="row-actions">
                    <button
                      onClick={async () => {
                        await api(`/api/admin/users/${user.id}/admin`, {
                          method: "POST",
                          body: JSON.stringify({ enabled: !user.is_admin }),
                        });
                        load();
                      }}
                    >
                      {user.is_admin ? "Remove admin" : "Make admin"}
                    </button>
                    {user.status !== "disabled" && (
                      <button
                        className="danger-link"
                        onClick={async () => {
                          await api(`/api/admin/users/${user.id}/disable`, { method: "POST" });
                          load();
                        }}
                      >
                        Disable
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function LoginPage({ navigate, show, notice, onAuthenticated }: any) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const identifier = String(new FormData(event.currentTarget).get("identifier"));
      const challenge = await api<any>("/api/auth/login/options", {
        method: "POST",
        body: JSON.stringify({ identifier }),
      });
      const response = await startAuthentication({ optionsJSON: challenge.options });
      const verified = await api<any>("/api/auth/login/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: challenge.challengeId, response }),
      });
      setCsrf(verified.csrfToken);
      await onAuthenticated();
    } catch (error) {
      show("error", message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      eyebrow="Passwordless control plane"
      title="Deploy with confidence"
      copy="Your projects, releases, and secrets stay on infrastructure you control."
    >
      {notice && <Notice {...notice} />}
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email
          <input
            name="identifier"
            type="email"
            autoComplete="username webauthn"
            autoFocus
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Waiting for Passkey…" : "Continue with Passkey"}
        </button>
      </form>
      <p className="auth-switch">
        New here? <button onClick={() => navigate("/register")}>Register a Passkey</button>
      </p>
    </AuthLayout>
  );
}

function RegisterPage({ navigate, show, notice }: any) {
  const [pending, setPending] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = new FormData(event.currentTarget);
      const challenge = await api<any>("/api/auth/register/options", {
        method: "POST",
        body: JSON.stringify({ email: data.get("email") }),
      });
      const response = await startRegistration({ optionsJSON: challenge.options });
      setPending(
        await api("/api/auth/register/verify", {
          method: "POST",
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            response,
            name: "Primary Passkey",
          }),
        }),
      );
    } catch (error) {
      show("error", message(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout
      eyebrow="Passkey enrollment"
      title="Create your identity"
      copy="The first account becomes administrator. Later users and additional Passkeys require approval."
    >
      {notice && <Notice {...notice} />}
      {pending ? (
        <div className="pending-card">
          <span className="pending-icon">✓</span>
          <h2>{pending.firstAdministrator ? "Administrator created" : "Passkey registered"}</h2>
          {pending.firstAdministrator ? (
            <p>This first account is active and has administrator access.</p>
          ) : (
            <>
              <p>An administrator can approve this request in the Dashboard or run:</p>
              <code>{pending.approvalCommand}</code>
              <p>
                Request code: <strong>{pending.requestCode}</strong>
              </p>
            </>
          )}
          <button onClick={() => navigate("/login")}>Return to sign in</button>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required autoFocus />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Creating Passkey…" : "Register Passkey"}
          </button>
        </form>
      )}
      {!pending && (
        <p className="auth-switch">
          Already approved? <button onClick={() => navigate("/login")}>Sign in</button>
        </p>
      )}
    </AuthLayout>
  );
}

function AuthLayout({ eyebrow, title: heading, copy, children }: any) {
  return (
    <div className="auth-page">
      <section className="auth-visual">
        <div className="brand auth-brand">
          <span className="brand-mark">W</span>
          <span>WebDeploy MCP</span>
        </div>
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{heading}</h1>
          <p>{copy}</p>
        </div>
        <div className="feature-strip">
          <span>Atomic releases</span>
          <span>Passkey security</span>
          <span>MCP native</span>
        </div>
      </section>
      <main className="auth-panel">{children}</main>
    </div>
  );
}

function Modal({ title: heading, children, onClose }: any) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-heading">
          <h2 id="modal-title">{heading}</h2>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty">
      <div className="empty-shape" />
      <h2>Ship your first project</h2>
      <p>Deploy from Git, an archive, or a handful of inline files.</p>
      <button className="primary" onClick={onCreate}>
        Create project
      </button>
    </section>
  );
}
function Loading() {
  return (
    <div className="loading" role="status">
      <span />
      <span />
      <span />
      <b>Loading WebDeploy…</b>
    </div>
  );
}
function Notice({ kind, text }: { kind: string; text: string }) {
  return (
    <div className={`notice ${kind}`} role="status">
      {text}
    </div>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function date(value: string) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "—";
}
