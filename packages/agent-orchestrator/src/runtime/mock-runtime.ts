import type { Runtime, RuntimeSpec, ProvisionResult, RuntimeStatus } from './runtime.js';

interface MockEntry {
  containerId: string;
  host: string;
  spec: RuntimeSpec;
}

/**
 * In-memory Runtime used by all tests. Records the exact spec it was given so
 * tests can assert that NO secret value appears in the spec (only the env-file
 * path) — proving the no-`ps`-visible-secret contract at the orchestrator seam.
 */
export class MockRuntime implements Runtime {
  readonly host: string;
  private readonly containers = new Map<string, MockEntry>();
  /** Append-only log of provision calls for assertions. */
  readonly provisionCalls: RuntimeSpec[] = [];
  readonly stopCalls: string[] = [];
  private counter = 0;

  constructor(host = 'mock-agent-host') {
    this.host = host;
  }

  async provision(spec: RuntimeSpec): Promise<ProvisionResult> {
    this.provisionCalls.push(spec);
    this.counter += 1;
    const containerId = `mock-${spec.userId}-${this.counter}`;
    this.containers.set(spec.userId, { containerId, host: this.host, spec });
    return { containerId, host: this.host };
  }

  async stop(userId: string): Promise<void> {
    this.stopCalls.push(userId);
    this.containers.delete(userId);
  }

  async status(userId: string): Promise<RuntimeStatus> {
    const entry = this.containers.get(userId);
    if (!entry) return { running: false };
    return { running: true, containerId: entry.containerId };
  }

  /** Test helper: how many containers are live. */
  count(): number {
    return this.containers.size;
  }

  /** Test helper: the spec the user was last provisioned with. */
  specFor(userId: string): RuntimeSpec | undefined {
    return this.containers.get(userId)?.spec;
  }
}
