// Fly Machines API client used by the control plane to spawn,
// wake, idle-stop, and destroy per-project sidecar Machines
// (milestone M7.1).
//
// Shape mirrors the iter-46 Cloudflare reconciler: pure helpers
// (URL/body/header construction, response parsing) sit at the top
// and are unit-tested directly; I/O methods on `MachinesClient`
// take an injectable `fetch` so the surface is testable without
// network.
//
// API reference: https://fly.io/docs/machines/api/
// Base URL: https://api.machines.dev/v1 (the same DNS name that
// `flyctl` uses for the same calls).
//
// Auth is `Authorization: Bearer <FLY_API_TOKEN>` against a token
// scoped to the org or app. The control plane will read its token
// from `FLY_API_TOKEN` (Fly secret) at boot.

const DEFAULT_BASE_URL = "https://api.machines.dev/v1";

export type MachineState =
  | "created"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "suspending"
  | "suspended"
  | "destroying"
  | "destroyed"
  | "replacing";

const KNOWN_STATES: ReadonlySet<MachineState> = new Set([
  "created",
  "starting",
  "started",
  "stopping",
  "stopped",
  "suspending",
  "suspended",
  "destroying",
  "destroyed",
  "replacing",
]);

export interface MachineConfig {
  readonly image: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly guest?: {
    readonly cpu_kind?: "shared" | "performance";
    readonly cpus?: number;
    readonly memory_mb?: number;
  };
  readonly auto_destroy?: boolean;
  readonly restart?: { readonly policy: "no" | "on-failure" | "always" };
  // Any extra fields are passed through verbatim — the Fly API
  // accepts a large open-ended config object and we don't want to
  // bottleneck on modelling every field here.
  readonly [k: string]: unknown;
}

export interface CreateMachineRequest {
  readonly name?: string;
  readonly region?: string;
  readonly config: MachineConfig;
}

export interface Machine {
  readonly id: string;
  readonly name?: string;
  readonly state: MachineState;
  readonly region?: string;
  readonly private_ip?: string;
  readonly instance_id?: string;
  readonly [k: string]: unknown;
}

export class FlyApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, url: string, body: unknown) {
    super(`Fly Machines API ${status} ${url}: ${stringifyBody(body)}`);
    this.name = "FlyApiError";
    this.status = status;
    this.body = body;
  }
}

function stringifyBody(body: unknown): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// ---------- pure helpers (exported for tests) ---------------------

export function buildMachinesUrl(
  baseUrl: string,
  appName: string,
  ...segments: ReadonlyArray<string | number>
): string {
  const base = baseUrl.replace(/\/$/, "");
  const parts = [encodeURIComponent(appName), ...segments.map(encodePart)];
  return `${base}/apps/${parts.join("/")}`;
}

function encodePart(p: string | number): string {
  return encodeURIComponent(String(p));
}

export function buildAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// 6PN address of a Machine on Fly's internal network.
//
// Per Fly docs, every Machine is reachable at
// `<machine-id>.vm.<app-name>.internal` on the 6PN. The control
// plane uses this rather than the per-app `<app>.internal` (which
// would round-robin across all machines) because routing to a
// specific project's Machine is the whole point of M7.1.
export function internalAddress(appName: string, machineId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(machineId)) {
    throw new Error(
      `internalAddress: machineId must be alphanumeric/_/- (got ${JSON.stringify(machineId)})`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(appName)) {
    throw new Error(
      `internalAddress: appName must be alphanumeric/_/- (got ${JSON.stringify(appName)})`,
    );
  }
  return `${machineId}.vm.${appName}.internal`;
}

export function parseMachineState(raw: unknown): MachineState {
  if (typeof raw !== "string" || !KNOWN_STATES.has(raw as MachineState)) {
    throw new Error(
      `Unrecognised Fly Machine state: ${JSON.stringify(raw)}`,
    );
  }
  return raw as MachineState;
}

function ensureMachine(body: unknown): Machine {
  if (typeof body !== "object" || body === null) {
    throw new Error(`Expected Machine object in response, got ${typeof body}`);
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.id !== "string") {
    throw new Error(`Machine response missing string \`id\``);
  }
  return { ...rec, id: rec.id, state: parseMachineState(rec.state) };
}

// ---------- client ------------------------------------------------

export interface MachinesClientOptions {
  readonly token: string;
  readonly appName: string;
  readonly baseUrl?: string;
  /** Override for tests. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

export class MachinesClient {
  private readonly token: string;
  private readonly appName: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MachinesClientOptions) {
    if (!opts.token) throw new Error("MachinesClient: token is required");
    if (!opts.appName)
      throw new Error("MachinesClient: appName is required");
    this.token = opts.token;
    this.appName = opts.appName;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async createMachine(req: CreateMachineRequest): Promise<Machine> {
    const url = buildMachinesUrl(this.baseUrl, this.appName, "machines");
    const body = await this.request(url, {
      method: "POST",
      body: JSON.stringify(req),
    });
    return ensureMachine(body);
  }

  async getMachine(machineId: string): Promise<Machine> {
    const url = buildMachinesUrl(
      this.baseUrl,
      this.appName,
      "machines",
      machineId,
    );
    const body = await this.request(url, { method: "GET" });
    return ensureMachine(body);
  }

  async startMachine(machineId: string): Promise<void> {
    const url = buildMachinesUrl(
      this.baseUrl,
      this.appName,
      "machines",
      machineId,
      "start",
    );
    await this.request(url, { method: "POST" });
  }

  // `signal` is one of `SIGINT`, `SIGTERM`, `SIGKILL`, etc. `timeout`
  // is seconds the API waits between the signal and a forced stop.
  async stopMachine(
    machineId: string,
    opts: { readonly signal?: string; readonly timeout?: number } = {},
  ): Promise<void> {
    const url = buildMachinesUrl(
      this.baseUrl,
      this.appName,
      "machines",
      machineId,
      "stop",
    );
    const payload: Record<string, unknown> = {};
    if (opts.signal !== undefined) payload.signal = opts.signal;
    if (opts.timeout !== undefined) payload.timeout = opts.timeout;
    await this.request(url, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // The API requires force=true to delete a started Machine. We
  // expose `force` rather than forcing it implicitly so callers can
  // choose whether they're confident the Machine is stopped.
  async destroyMachine(
    machineId: string,
    opts: { readonly force?: boolean } = {},
  ): Promise<void> {
    const qs = opts.force ? "?force=true" : "";
    const url =
      buildMachinesUrl(this.baseUrl, this.appName, "machines", machineId) +
      qs;
    await this.request(url, { method: "DELETE" });
  }

  // Block until the Machine reaches `state` (or a terminal state)
  // or the API-side timeout fires. `timeoutSec` defaults to 60; the
  // Fly API itself caps this at 60.
  async waitForState(
    machineId: string,
    state: MachineState,
    opts: { readonly timeoutSec?: number } = {},
  ): Promise<void> {
    const timeoutSec = opts.timeoutSec ?? 60;
    const url =
      buildMachinesUrl(
        this.baseUrl,
        this.appName,
        "machines",
        machineId,
        "wait",
      ) + `?state=${encodeURIComponent(state)}&timeout=${timeoutSec}`;
    await this.request(url, { method: "GET" });
  }

  internalAddress(machineId: string): string {
    return internalAddress(this.appName, machineId);
  }

  private async request(
    url: string,
    init: { method: string; body?: string },
  ): Promise<unknown> {
    const headers = buildAuthHeaders(this.token);
    const res = await this.fetchImpl(url, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new FlyApiError(res.status, url, parsed);
    }
    return parsed;
  }
}
