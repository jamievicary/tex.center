// One-shot Cloudflare DNS reconciler for the apex `tex.center`.
//
// Why a script and not a workspace package: this runs from a
// developer machine (or a future deploy hook) against Cloudflare's
// live API and `creds/cloudflare.token`. No runtime code in the
// product depends on it. The pure `reconcileRecords` helper has
// unit tests; the I/O wrappers have stub-fetch tests; the CLI is
// not test-covered (it just composes them).
//
// Usage:
//   node scripts/cloudflare-dns.mjs \
//       --zone tex.center \
//       --ipv4 1.2.3.4 \
//       --ipv6 2606:4700::1 \
//       [--acme-name _acme-challenge.tex.center --acme-value abc...] \
//       [--dry-run]
//
// The token is read from `creds/cloudflare.token` (path can be
// overridden with `--token-file`). The script only ever touches
// records whose (type, name) appears in the desired set passed in —
// it will not delete unrelated records in the zone.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const CF_API = "https://api.cloudflare.com/client/v4";

// ---------- pure helpers (exported for tests) ---------------------

/**
 * Compare existing Cloudflare records against the desired set and
 * return the create/update/delete ops needed to converge.
 *
 * Records are matched by (type, name). For each managed key we keep
 * at most one record; if Cloudflare somehow returned multiple, the
 * first wins and the rest are deleted.
 *
 * @param {{
 *   existing: Array<{id: string, type: string, name: string, content: string, ttl?: number, proxied?: boolean}>,
 *   desired: Array<{type: string, name: string, content: string, ttl?: number, proxied?: boolean}>,
 * }} input
 */
export function reconcileRecords({ existing, desired }) {
  const managed = new Set(desired.map((d) => `${d.type}|${d.name}`));
  const toCreate = [];
  const toUpdate = [];
  const toDelete = [];

  // Bucket existing by managed key (only managed keys are touched).
  /** @type {Map<string, typeof existing>} */
  const byKey = new Map();
  for (const r of existing) {
    const k = `${r.type}|${r.name}`;
    if (!managed.has(k)) continue;
    const bucket = byKey.get(k) ?? [];
    bucket.push(r);
    byKey.set(k, bucket);
  }

  for (const d of desired) {
    const k = `${d.type}|${d.name}`;
    const bucket = byKey.get(k) ?? [];
    if (bucket.length === 0) {
      toCreate.push(d);
      continue;
    }
    const [primary, ...rest] = bucket;
    // Any duplicates collapse to deletes.
    for (const dup of rest) toDelete.push(dup);
    const sameContent = primary.content === d.content;
    const sameTtl = (primary.ttl ?? 1) === (d.ttl ?? 1);
    const sameProxied =
      Boolean(primary.proxied) === Boolean(d.proxied);
    if (!sameContent || !sameTtl || !sameProxied) {
      toUpdate.push({ id: primary.id, ...d });
    }
    byKey.delete(k);
  }

  return { toCreate, toUpdate, toDelete };
}

export function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ---------- I/O wrappers ------------------------------------------

async function cfFetch(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const body = await res.json();
  if (!res.ok || body?.success === false) {
    const errs = JSON.stringify(body?.errors ?? body);
    throw new Error(`Cloudflare API ${res.status} ${url}: ${errs}`);
  }
  return body.result;
}

export async function fetchZoneId(token, zoneName, { fetch: f = fetch } = {}) {
  const url = `${CF_API}/zones?name=${encodeURIComponent(zoneName)}`;
  const result = await cfFetch(f, url, { headers: buildHeaders(token) });
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error(`Cloudflare zone not found: ${zoneName}`);
  }
  return result[0].id;
}

export async function listRecords(token, zoneId, { fetch: f = fetch } = {}) {
  // per_page=100 is plenty for the apex of a single-purpose zone.
  const url = `${CF_API}/zones/${zoneId}/dns_records?per_page=100`;
  return cfFetch(f, url, { headers: buildHeaders(token) });
}

export async function createRecord(token, zoneId, record, { fetch: f = fetch } = {}) {
  const url = `${CF_API}/zones/${zoneId}/dns_records`;
  return cfFetch(f, url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(record),
  });
}

export async function updateRecord(token, zoneId, record, { fetch: f = fetch } = {}) {
  const { id, ...rest } = record;
  const url = `${CF_API}/zones/${zoneId}/dns_records/${id}`;
  return cfFetch(f, url, {
    method: "PUT",
    headers: buildHeaders(token),
    body: JSON.stringify(rest),
  });
}

export async function deleteRecord(token, zoneId, id, { fetch: f = fetch } = {}) {
  const url = `${CF_API}/zones/${zoneId}/dns_records/${id}`;
  return cfFetch(f, url, { method: "DELETE", headers: buildHeaders(token) });
}

// ---------- CLI ---------------------------------------------------

function buildDesired(zone, { ipv4, ipv6, acmeName, acmeValue }) {
  const desired = [];
  if (ipv4) desired.push({ type: "A", name: zone, content: ipv4, ttl: 1, proxied: false });
  if (ipv6) desired.push({ type: "AAAA", name: zone, content: ipv6, ttl: 1, proxied: false });
  if (acmeName && acmeValue) {
    desired.push({ type: "TXT", name: acmeName, content: acmeValue, ttl: 1, proxied: false });
  }
  return desired;
}

export { buildDesired };

async function main() {
  const { values } = parseArgs({
    options: {
      zone: { type: "string" },
      ipv4: { type: "string" },
      ipv6: { type: "string" },
      "acme-name": { type: "string" },
      "acme-value": { type: "string" },
      "token-file": { type: "string", default: "creds/cloudflare.token" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.zone) throw new Error("--zone is required");
  if (!values.ipv4 && !values.ipv6 && !values["acme-value"]) {
    throw new Error("at least one of --ipv4 / --ipv6 / --acme-value is required");
  }

  const token = readFileSync(values["token-file"], "utf8").trim();
  if (!token) throw new Error(`empty token at ${values["token-file"]}`);

  const desired = buildDesired(values.zone, {
    ipv4: values.ipv4,
    ipv6: values.ipv6,
    acmeName: values["acme-name"],
    acmeValue: values["acme-value"],
  });

  const zoneId = await fetchZoneId(token, values.zone);
  const existing = await listRecords(token, zoneId);
  const ops = reconcileRecords({ existing, desired });

  const summary = `create=${ops.toCreate.length} update=${ops.toUpdate.length} delete=${ops.toDelete.length}`;
  console.log(`zone=${values.zone} id=${zoneId} ${summary}`);

  if (values["dry-run"]) {
    console.log(JSON.stringify(ops, null, 2));
    return;
  }

  for (const r of ops.toCreate) {
    await createRecord(token, zoneId, r);
    console.log(`+ ${r.type} ${r.name} ${r.content}`);
  }
  for (const r of ops.toUpdate) {
    await updateRecord(token, zoneId, r);
    console.log(`~ ${r.type} ${r.name} ${r.content}`);
  }
  for (const r of ops.toDelete) {
    await deleteRecord(token, zoneId, r.id);
    console.log(`- ${r.type} ${r.name} ${r.content} (id=${r.id})`);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isMain) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
