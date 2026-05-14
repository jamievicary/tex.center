// Orphan-tagged sidecar Machine sweep (M9.live-hygiene).
//
// Background: every per-project sidecar Machine the control plane
// creates is tagged with `config.metadata.texcenter_project=<id>`
// since iter 243. The intent is that `cleanupLiveProjectMachine`
// reaps the Machine in each spec's `afterEach`, but two failure
// shapes still produce orphans the count guardrail
// (`test_machine_count_under_threshold`) trips on:
//
//   (a) Spec's cleanup helper deletes the `machine_assignments` row
//       (and the `projects` row) but the Fly destroy call fails or
//       was never reached. The Machine survives with its tag, but
//       no DB trace remains for a subsequent retry.
//   (b) Spec creates a project, opens the editor, the Machine gets
//       created + tagged, but the test (or the runner) dies before
//       the assignment row lands — same shape on the live side.
//
// Both leave a tagged Machine whose `texcenter_project` ID is not
// in `projects`. The sweep here lists every Machine, filters to
// those with a `texcenter_project` tag, and destroys any whose tag
// does not match a current `projects.id` (and is not on an explicit
// protect list — used by the bootstrap to guard its own warm
// project against an in-window race where its row was just dropped
// but its Machine is still being reaped through its own teardown).
//
// Pure logic: I/O is injected as `listMachines` / `destroyMachine` /
// `getKnownProjectIds`. Tests stub these.

export interface SidecarMachineSummary {
  readonly id: string;
  readonly metadata: Readonly<Record<string, string>> | null;
}

export interface MachineLister {
  listMachines(): Promise<readonly SidecarMachineSummary[]>;
}

export interface MachineDestroyer {
  destroyMachine(
    machineId: string,
    opts?: { readonly force?: boolean },
  ): Promise<void>;
}

export interface ProjectIdSource {
  getKnownProjectIds(): Promise<ReadonlySet<string>>;
}

export interface SweepInput {
  readonly machines: MachineLister & MachineDestroyer;
  readonly projects: ProjectIdSource;
  /** Project IDs to spare even if absent from the DB. */
  readonly protectIds?: ReadonlySet<string>;
}

export interface SweepReport {
  readonly inspected: number;
  readonly tagged: number;
  /** Machine IDs destroyed by this sweep. */
  readonly destroyed: readonly string[];
  /** Machine IDs whose destroy attempt threw (re-thrown after loop). */
  readonly failed: ReadonlyArray<{
    readonly machineId: string;
    readonly tag: string;
    readonly error: string;
  }>;
}

export async function sweepOrphanedSidecarMachines(
  input: SweepInput,
): Promise<SweepReport> {
  const all = await input.machines.listMachines();
  const known = await input.projects.getKnownProjectIds();
  const protectIds = input.protectIds ?? new Set<string>();

  const destroyed: string[] = [];
  const failed: { machineId: string; tag: string; error: string }[] = [];
  let tagged = 0;

  for (const m of all) {
    const tag = m.metadata?.texcenter_project;
    if (typeof tag !== "string" || tag === "") continue;
    tagged += 1;
    if (known.has(tag) || protectIds.has(tag)) continue;
    try {
      await input.machines.destroyMachine(m.id, { force: true });
      destroyed.push(m.id);
    } catch (err) {
      if (isAlreadyGone(err)) {
        destroyed.push(m.id);
        continue;
      }
      failed.push({
        machineId: m.id,
        tag,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    inspected: all.length,
    tagged,
    destroyed,
    failed,
  };
}

function isAlreadyGone(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as { status?: unknown };
  return rec.status === 404;
}
