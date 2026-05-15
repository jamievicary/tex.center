// Toast store for the editor UI. Designed to admit both
// user-visible toasts (info / success / error) and
// debug-protocol toasts driven by `?debug=1` (one toast per
// observed WS frame, color-coded by category — see
// `.autodev/discussion/174_answer.md`).
//
// API: `push({ category, text, ttlMs?, persistent?, aggregateKey? })`.
// Aggregation: pushes sharing an `aggregateKey` within
// `AGGREGATE_WINDOW_MS` of the previous push merge into the
// existing toast and bump its `count`. The window resets each
// time a matching push extends the toast; a non-matching push
// or window expiry ends the aggregation.
//
// TTL: defaults per category (errors: 6s, success: 3s, info: 5s,
// debug-*: 10s — M22.4a). `persistent: true` disables auto-dismiss;
// the consumer must call `dismiss(id)`.
//
// Subscription: Svelte-store contract — `subscribe(fn)` is
// called immediately with the current array and again on every
// change. Returns an unsubscribe function.

export type ToastCategory =
  | "info"
  | "success"
  | "error"
  | "debug-blue"
  | "debug-green"
  | "debug-orange"
  | "debug-grey"
  | "debug-red";

export interface ToastInput {
  category: ToastCategory;
  text: string;
  ttlMs?: number;
  persistent?: boolean;
  aggregateKey?: string;
}

export interface Toast {
  id: number;
  category: ToastCategory;
  text: string;
  count: number;
  persistent: boolean;
  ttlMs: number | null;
  aggregateKey: string | null;
  createdAt: number;
}

export const AGGREGATE_WINDOW_MS = 500;

export const DEFAULT_TTL_MS: Record<ToastCategory, number> = {
  info: 5_000,
  success: 3_000,
  error: 6_000,
  "debug-blue": 10_000,
  "debug-green": 10_000,
  "debug-orange": 10_000,
  "debug-grey": 10_000,
  "debug-red": 10_000,
};

type Subscriber = (toasts: ReadonlyArray<Toast>) => void;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface ToastStore {
  subscribe(fn: Subscriber): () => void;
  push(input: ToastInput): number;
  dismiss(id: number): void;
  clear(): void;
  /** Visible for testing. */
  _now(): number;
}

export interface ToastStoreOptions {
  /** Injectable for unit tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for unit tests; defaults to `setTimeout`. */
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  /** Injectable for unit tests; defaults to `clearTimeout`. */
  clearTimeout?: (h: TimerHandle) => void;
}

export function createToastStore(opts: ToastStoreOptions = {}): ToastStore {
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h) => clearTimeout(h));

  let toasts: Toast[] = [];
  const subs = new Set<Subscriber>();
  const timers = new Map<number, TimerHandle>();
  // Tracks last push time per aggregateKey for the window check.
  const lastPushAt = new Map<string, { id: number; at: number }>();
  let nextId = 1;

  function notify(): void {
    const snap = toasts.slice();
    for (const fn of subs) fn(snap);
  }

  function armTtl(t: Toast): void {
    if (t.persistent || t.ttlMs === null) return;
    const prev = timers.get(t.id);
    if (prev !== undefined) clearT(prev);
    const h = setT(() => {
      timers.delete(t.id);
      dismiss(t.id);
    }, t.ttlMs);
    timers.set(t.id, h);
  }

  function dismiss(id: number): void {
    const i = toasts.findIndex((x) => x.id === id);
    if (i < 0) return;
    const t = toasts[i]!;
    toasts.splice(i, 1);
    const h = timers.get(id);
    if (h !== undefined) {
      clearT(h);
      timers.delete(id);
    }
    if (t.aggregateKey !== null) {
      const last = lastPushAt.get(t.aggregateKey);
      if (last && last.id === id) lastPushAt.delete(t.aggregateKey);
    }
    notify();
  }

  function push(input: ToastInput): number {
    const t = now();
    const key = input.aggregateKey ?? null;
    if (key !== null) {
      const last = lastPushAt.get(key);
      if (last && t - last.at <= AGGREGATE_WINDOW_MS) {
        const existing = toasts.find((x) => x.id === last.id);
        if (existing) {
          existing.count += 1;
          existing.text = input.text;
          lastPushAt.set(key, { id: existing.id, at: t });
          armTtl(existing);
          notify();
          return existing.id;
        }
      }
    }
    const id = nextId++;
    const ttl = input.persistent
      ? null
      : (input.ttlMs ?? DEFAULT_TTL_MS[input.category]);
    const toast: Toast = {
      id,
      category: input.category,
      text: input.text,
      count: 1,
      persistent: input.persistent === true,
      ttlMs: ttl,
      aggregateKey: key,
      createdAt: t,
    };
    toasts.push(toast);
    if (key !== null) lastPushAt.set(key, { id, at: t });
    armTtl(toast);
    notify();
    return id;
  }

  function subscribe(fn: Subscriber): () => void {
    subs.add(fn);
    fn(toasts.slice());
    return () => {
      subs.delete(fn);
    };
  }

  function clear(): void {
    for (const h of timers.values()) clearT(h);
    timers.clear();
    lastPushAt.clear();
    toasts = [];
    notify();
  }

  return { subscribe, push, dismiss, clear, _now: now };
}

// Module-level singleton for the running app. Tests construct
// their own via `createToastStore({ now, setTimeout })`.
export const toasts: ToastStore = createToastStore();
