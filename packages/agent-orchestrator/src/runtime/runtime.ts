/**
 * The Runtime abstraction: the orchestrator talks to a container backend only
 * through this interface. DockerRuntime is the real impl (Docker Engine API);
 * MockRuntime is the in-memory impl used by every test.
 *
 * SECURITY CONTRACT: the spec NEVER carries the user's secrets inline. Secrets
 * live in a 0600 env-file on the host (written by the Orchestrator); the spec
 * only references that file via `envFilePath` + the in-container `envFileTarget`
 * mount path. A Runtime impl mounts the file read-only and MUST NOT pass any of
 * the secret values via `-e VAR=...` / argv (visible to `ps`/`inspect`).
 */
export interface RuntimeSpec {
  userId: string;
  image: string;
  /** Host path to the 0600 env-file holding the per-user secrets. */
  envFilePath: string;
  /** In-container mount target the base-image entrypoint sources. */
  envFileTarget: string;
  /** Hard memory limit in bytes. */
  memoryBytes: number;
  /** Docker labels; always includes `ll5.user_id`. */
  labels: Record<string, string>;
  /** Restart policy name passed to the Docker Engine API (e.g. 'unless-stopped'). */
  restartPolicy: string;
  /** Docker network to attach the container to so it can reach gateway/MCPs by
   *  hostname (the ll5 stack network). Empty → default bridge (isolated). */
  network?: string;
}

export interface ProvisionResult {
  containerId: string;
  host: string;
}

export interface RuntimeStatus {
  running: boolean;
  containerId?: string;
}

export interface Runtime {
  provision(spec: RuntimeSpec): Promise<ProvisionResult>;
  stop(userId: string): Promise<void>;
  status(userId: string): Promise<RuntimeStatus>;
}
