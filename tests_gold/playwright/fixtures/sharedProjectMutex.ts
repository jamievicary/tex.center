// Cross-process mutex for the shared live project (`sharedLiveProject`
// fixture). Used to keep workers > 1 safe.
//
// The 7 shared-project specs (`verifyLiveGt[1,2,3,4,5,7]*`,
// `verifyLivePdfNoFlashBetweenSegments`) all read/write the SAME
// bootstrapped live project, so concurrent execution would corrupt
// each other's state — GT-3 counts pdf-segments while GT-4 types,
// etc. They must run serially even when other live specs run in
// parallel on a second worker.
//
// Playwright has no built-in primitive for cross-file, cross-worker
// serialisation. This module provides one via an atomic `mkdir` of a
// well-known path under `os.tmpdir()`. Each shared-project spec
// acquires the lock at the start of the `liveProject` fixture and
// releases it on fixture teardown.
//
// Stale-lock handling: if the holder dies mid-test, the lock dir
// stays. Subsequent acquirers check the recorded PID — if the
// process is gone, the lock is reclaimed immediately. Belt and
// braces: a `STALE_MS` upper bound also reclaims any lock whose
// mtime is older than the longest plausible shared-project spec
// (currently GT-4 sustained typing at ~36 s, so 90 s is safe).

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const LOCK_DIR = join(tmpdir(), "tex-center-gold-shared-project.lock");
const PID_FILE = join(LOCK_DIR, "pid");
const STALE_MS = 90_000;
const ACQUIRE_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 100;

function pidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually kill — it probes deliverability.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryReclaim(): Promise<boolean> {
  let pidStr: string;
  try {
    pidStr = await readFile(PID_FILE, "utf8");
  } catch {
    // pid file missing — could be a race during acquire. Treat as
    // stale (the holder never finished claiming it).
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
    return true;
  }
  const pid = parseInt(pidStr.trim(), 10);
  if (Number.isFinite(pid) && !pidAlive(pid)) {
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
    return true;
  }
  try {
    const st = await stat(LOCK_DIR);
    if (Date.now() - st.mtimeMs > STALE_MS) {
      await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

export async function acquireSharedProjectLock(): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(PID_FILE, String(process.pid));
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (await tryReclaim()) continue;
      await wait(POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `acquireSharedProjectLock: timed out after ${ACQUIRE_TIMEOUT_MS}ms ` +
      `waiting on ${LOCK_DIR}`,
  );
}

export async function releaseSharedProjectLock(): Promise<void> {
  await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
}
