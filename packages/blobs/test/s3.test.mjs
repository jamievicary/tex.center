// Round-trip + signing tests for the S3 BlobStore.
//
// Backed by an in-process `http.Server` that emulates the tiny
// subset of S3 we use (PUT/GET/DELETE/HEAD on `/<bucket>/<key>` and
// GET `?list-type=2&prefix=...` returning a minimal
// `<ListBucketResult>` XML, with paginated continuation tokens).
// The stub also records every incoming request so the canonical
// request shape (path-style addressing, payload hash header, signed
// `Authorization`) can be asserted directly.
//
// Tests are hermetic — no real network — but exercise the same
// `BlobStore` surface as `localFs.test.mjs` so the two adapters
// stay interchangeable behind the protocol.

import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  S3BlobStore,
  defaultBlobStoreFromEnv,
  signRequest,
  validateKey,
} from "../src/index.ts";
import { createHash } from "node:crypto";

function makeStub({ pageSize = 1000 } = {}) {
  const blobs = new Map();
  const recorded = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://${req.headers.host}`);
      recorded.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: { ...req.headers },
        body,
      });
      const segments = url.pathname.split("/").filter(Boolean);
      const [bucket, ...keyParts] = segments;
      if (bucket !== "test-bucket") {
        res.writeHead(400);
        res.end();
        return;
      }
      const key = keyParts.map(decodeURIComponent).join("/");

      if (req.method === "PUT") {
        blobs.set(key, body);
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        blobs.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "HEAD" && key === "") {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const all = [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
        let startIndex = 0;
        const token = url.searchParams.get("continuation-token");
        if (token) startIndex = Number(Buffer.from(token, "base64").toString("utf8"));
        const slice = all.slice(startIndex, startIndex + pageSize);
        const isTruncated = startIndex + slice.length < all.length;
        const nextToken = isTruncated
          ? Buffer.from(String(startIndex + slice.length)).toString("base64")
          : null;
        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          "<ListBucketResult>",
          `<IsTruncated>${isTruncated ? "true" : "false"}</IsTruncated>`,
          ...slice.map((k) => `<Contents><Key>${escapeXml(k)}</Key></Contents>`),
          nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "",
          "</ListBucketResult>",
        ].join("");
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(xml);
        return;
      }
      if (req.method === "GET") {
        const blob = blobs.get(key);
        if (blob === undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-length": String(blob.length) });
        res.end(blob);
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });

  return { server, blobs, recorded };
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function shutdown(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// --------------------------------------------------------------------
// sigv4: known-answer test from AWS docs (GET object example), pinning
// the canonical request + signature shape so a future refactor of
// signRequest can't silently change wire output.
// --------------------------------------------------------------------
{
  // AWS example: GET https://examplebucket.s3.amazonaws.com/test.txt
  // with Range: bytes=0-9 at 20130524T000000Z.
  const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
  const signed = signRequest({
    method: "GET",
    url,
    headers: { range: "bytes=0-9" },
    region: "us-east-1",
    service: "s3",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });
  assert.equal(signed["x-amz-date"], "20130524T000000Z");
  // SHA-256 of an empty body.
  assert.equal(
    signed["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  // Signature published in AWS docs:
  //   https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  // (GetObject example with Range header).
  const expected =
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41";
  assert.match(signed.authorization, new RegExp(`Signature=${expected}$`));
  assert.match(
    signed.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request,/,
  );
  // SignedHeaders are alphabetical and exclude `authorization`.
  assert.match(signed.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
}

// --------------------------------------------------------------------
// Round-trip surface against the stub.
// --------------------------------------------------------------------
const { server, blobs, recorded } = makeStub({ pageSize: 2 });
const endpoint = await listen(server);

try {
  const store = new S3BlobStore({
    endpoint,
    region: "auto",
    bucket: "test-bucket",
    accessKeyId: "AKIA-TEST",
    secretAccessKey: "TEST-SECRET-DO-NOT-USE",
  });

  // put/get round-trip with a nested key.
  {
    const body = new Uint8Array([0, 1, 2, 3, 4, 255]);
    await store.put("projects/p1/files/main.tex", body);
    const got = await store.get("projects/p1/files/main.tex");
    assert.ok(got !== null);
    assert.deepEqual(Array.from(got), Array.from(body));

    // The stub recorded a path-style PUT with the right shape.
    const putReq = recorded.find((r) => r.method === "PUT");
    assert.equal(putReq.path, "/test-bucket/projects/p1/files/main.tex");
    // x-amz-content-sha256 matches the body hash.
    const expectedHash = createHash("sha256").update(Buffer.from(body)).digest("hex");
    assert.equal(putReq.headers["x-amz-content-sha256"], expectedHash);
    // Authorization is SigV4 with our access key, "s3" service.
    assert.match(
      putReq.headers["authorization"],
      /^AWS4-HMAC-SHA256 Credential=AKIA-TEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/,
    );
  }

  // get on missing key → null (no throw).
  {
    const got = await store.get("projects/p1/missing");
    assert.equal(got, null);
  }

  // overwrite replaces value.
  {
    await store.put("projects/p1/files/main.tex", new Uint8Array([9, 9]));
    const got = await store.get("projects/p1/files/main.tex");
    assert.deepEqual(Array.from(got), [9, 9]);
  }

  // list with prefix; force pagination via pageSize=2 above.
  {
    await store.put("projects/p1/files/sub/a.tex", new Uint8Array([1]));
    await store.put("projects/p1/files/sub/b.tex", new Uint8Array([2]));
    await store.put("projects/p2/files/main.tex", new Uint8Array([3]));
    const keys = await store.list("projects/p1");
    assert.deepEqual(keys, [
      "projects/p1/files/main.tex",
      "projects/p1/files/sub/a.tex",
      "projects/p1/files/sub/b.tex",
    ]);
    // 3 keys with pageSize=2 → at least two LIST requests with
    // continuation-token on the second.
    const listReqs = recorded.filter(
      (r) => r.method === "GET" && r.query["list-type"] === "2" && r.query.prefix === "projects/p1",
    );
    assert.ok(listReqs.length >= 2, `expected paginated LIST, got ${listReqs.length} request(s)`);
    assert.ok(
      listReqs.some((r) => "continuation-token" in r.query),
      "expected at least one paginated request to carry a continuation-token",
    );
  }

  // list of empty store / non-existent prefix → [].
  {
    const keys = await store.list("projects/nope");
    assert.deepEqual(keys, []);
  }

  // delete is idempotent (server returns 204 either way).
  {
    await store.delete("projects/p2/files/main.tex");
    await store.delete("projects/p2/files/main.tex");
    const got = await store.get("projects/p2/files/main.tex");
    assert.equal(got, null);
  }

  // 404 on delete also treated as success (some S3-compatibles return that).
  {
    const stub404 = createServer((req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    const ep = await listen(stub404);
    try {
      const s = new S3BlobStore({
        endpoint: ep,
        region: "auto",
        bucket: "test-bucket",
        accessKeyId: "k",
        secretAccessKey: "s",
      });
      await s.delete("missing/key");
    } finally {
      await shutdown(stub404);
    }
  }

  // key validation rejects traversal & weirdness on get/put/delete.
  {
    const bad = ["", "/abs", "trailing/", "a//b", "a/../b", "a/./b", "a\\b", "a\0b"];
    for (const key of bad) {
      assert.throws(() => validateKey(key), new RegExp("invalid|non-empty"));
      await assert.rejects(store.get(key), /invalid|non-empty/);
    }
  }

  // health: bucket reachable → resolves.
  {
    await store.health();
    const headReq = recorded.find((r) => r.method === "HEAD");
    assert.equal(headReq.path, "/test-bucket");
  }

  // health: bucket 403 / 404 → throws.
  {
    const stubDeny = createServer((req, res) => {
      res.writeHead(403);
      res.end();
    });
    const ep = await listen(stubDeny);
    try {
      const s = new S3BlobStore({
        endpoint: ep,
        region: "auto",
        bucket: "denied",
        accessKeyId: "k",
        secretAccessKey: "s",
      });
      await assert.rejects(s.health(), /not accessible: 403/);
    } finally {
      await shutdown(stubDeny);
    }
  }

  // get on a 500 → throws (not null; null is reserved for 404).
  {
    const stub500 = createServer((req, res) => {
      res.writeHead(500);
      res.end();
    });
    const ep = await listen(stub500);
    try {
      const s = new S3BlobStore({
        endpoint: ep,
        region: "auto",
        bucket: "test-bucket",
        accessKeyId: "k",
        secretAccessKey: "s",
      });
      await assert.rejects(s.get("a/b/c"), /s3 GET a\/b\/c → 500/);
    } finally {
      await shutdown(stub500);
    }
  }

  // envSelect: BLOB_STORE=s3 wires up an S3BlobStore.
  {
    const got = defaultBlobStoreFromEnv({
      BLOB_STORE: "s3",
      BLOB_STORE_S3_ENDPOINT: "https://fly.storage.tigris.dev",
      BLOB_STORE_S3_REGION: "auto",
      BLOB_STORE_S3_BUCKET: "tex-center-blobs",
      BLOB_STORE_S3_ACCESS_KEY_ID: "k",
      BLOB_STORE_S3_SECRET_ACCESS_KEY: "s",
    });
    assert.ok(got instanceof S3BlobStore);
  }

  // envSelect: missing fields are named in the error. Each missing-
  // field error names BOTH the primary `BLOB_STORE_S3_*` key and the
  // AWS-SDK fallback (so a deploy missing both prefixes for a field
  // sees both candidate names).
  {
    const cases = [
      ["BLOB_STORE_S3_ENDPOINT", "AWS_ENDPOINT_URL_S3"],
      ["BLOB_STORE_S3_REGION", "AWS_REGION"],
      ["BLOB_STORE_S3_BUCKET", "BUCKET_NAME"],
      ["BLOB_STORE_S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"],
      ["BLOB_STORE_S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
    ];
    for (const [missingPrimary, missingFallback] of cases) {
      const env = {
        BLOB_STORE: "s3",
        BLOB_STORE_S3_ENDPOINT: "https://example",
        BLOB_STORE_S3_REGION: "auto",
        BLOB_STORE_S3_BUCKET: "b",
        BLOB_STORE_S3_ACCESS_KEY_ID: "k",
        BLOB_STORE_S3_SECRET_ACCESS_KEY: "s",
      };
      delete env[missingPrimary];
      assert.throws(
        () => defaultBlobStoreFromEnv(env),
        new RegExp(
          `requires ${missingPrimary} or ${missingFallback}`,
        ),
        `expected error naming ${missingPrimary} and ${missingFallback}`,
      );
    }
  }

  // envSelect: AWS-SDK env names alone (no BLOB_STORE_S3_*) wire up
  // an S3BlobStore. This is the shape `flyctl storage create -a <app>`
  // auto-injects.
  {
    const got = defaultBlobStoreFromEnv({
      BLOB_STORE: "s3",
      AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
      AWS_REGION: "auto",
      BUCKET_NAME: "tex-center-blobs",
      AWS_ACCESS_KEY_ID: "k",
      AWS_SECRET_ACCESS_KEY: "s",
    });
    assert.ok(got instanceof S3BlobStore);
  }

  // envSelect: mixed prefixes (some BLOB_STORE_S3_*, some AWS_*)
  // wire up cleanly.
  {
    const got = defaultBlobStoreFromEnv({
      BLOB_STORE: "s3",
      BLOB_STORE_S3_ENDPOINT: "https://fly.storage.tigris.dev",
      AWS_REGION: "auto",
      BLOB_STORE_S3_BUCKET: "tex-center-blobs",
      AWS_ACCESS_KEY_ID: "k",
      BLOB_STORE_S3_SECRET_ACCESS_KEY: "s",
    });
    assert.ok(got instanceof S3BlobStore);
  }

  // envSelect: BLOB_STORE_S3_BUCKET takes precedence over BUCKET_NAME
  // when both are set. Verified by routing a put through the stub —
  // the stub only honors `test-bucket`, so a precedence flip would
  // reject with 400. Symmetric case: drop BLOB_STORE_S3_BUCKET and
  // keep only the (incorrect) BUCKET_NAME → the put rejects.
  {
    const storeWithOverride = defaultBlobStoreFromEnv({
      BLOB_STORE: "s3",
      BLOB_STORE_S3_ENDPOINT: endpoint,
      BLOB_STORE_S3_REGION: "auto",
      BLOB_STORE_S3_BUCKET: "test-bucket",
      BUCKET_NAME: "wrong-bucket",
      BLOB_STORE_S3_ACCESS_KEY_ID: "k",
      BLOB_STORE_S3_SECRET_ACCESS_KEY: "s",
    });
    // BLOB_STORE_S3_BUCKET wins → put succeeds.
    await storeWithOverride.put(
      "projects/precedence/files/main.tex",
      new Uint8Array([42]),
    );

    const storeAwsOnly = defaultBlobStoreFromEnv({
      BLOB_STORE: "s3",
      AWS_ENDPOINT_URL_S3: endpoint,
      AWS_REGION: "auto",
      BUCKET_NAME: "wrong-bucket",
      AWS_ACCESS_KEY_ID: "k",
      AWS_SECRET_ACCESS_KEY: "s",
    });
    // BUCKET_NAME used → stub rejects with 400.
    await assert.rejects(
      () =>
        storeAwsOnly.put(
          "projects/precedence/files/main.tex",
          new Uint8Array([42]),
        ),
      /s3 PUT .* → 400/,
    );
  }

  // Make sure unused locals aren't accidental:
  assert.ok(blobs.size > 0, "stub should have stored blobs during round-trip");
} finally {
  await shutdown(server);
}

console.log("s3.test.mjs: OK");
