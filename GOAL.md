# tex.center — Project Goal

## Vision

A cloud-based LaTeX editor (similar to Overleaf) built on top of **supertex**, an
incremental LaTeX→PDF compiler authored by the project owner. The defining feature
is **edit-to-preview latency in the hundreds of milliseconds**, achieved by
exploiting supertex's checkpoint/resume model and the incremental PDF wire format.

Live at **https://tex.center**.

## MVP scope (what "launched" means)

Achieving a **live, continuously-deployed service at https://tex.center**
is the goal of this project, and **doing so end-to-end is in scope for the
autodev engineer** — not a separate manual step the user performs after
autodev is done. That includes running `flyctl` to create and configure the
Fly app, Machines, Postgres, and Tigris; running `gh` to push GitHub
Actions secrets; running the Cloudflare API to configure DNS for
`tex.center`; provisioning the Google OAuth app's authorised redirect URIs
where the platform allows it; and verifying the live deployment with real
HTTPS probes. All credentials needed are supplied in `creds/` (see the
"External services & credentials" section below). Any work that
PLAN.md has historically labelled "out-of-tree one-shot" is, in fact,
in-tree iteration work: pick it up, execute it against the live services
using the credentials provided, and commit any resulting state (issued IPs,
machine IDs, app IDs, etc.) back into the repo.

To achieve this, it's critical that the gold test suite contains full realistic tests of all aspects of this user experience. If the system breaks, we need to know through the gold tests which run each iteration, we don't want to wait for the human to discover the problem.

A working deployment at https://tex.center where:

1. **Unauthenticated visitors see a plain white page with a single "Sign in with
   Google" button.** No product details, branding, marketing copy, or hints about
   what the service does must be visible to non-logged-in users.
2. After Google login, **only `jamievicary@gmail.com` is admitted.** All other
   accounts are signed out immediately and returned to the white page.
3. The authenticated user sees a **three-panel editor**:
   - Left: file tree of the current project (upload, create, rename, delete files).
   - Middle: CodeMirror 6 editor with LaTeX syntax mode.
   - Right: PDF preview rendered with PDF.js.
4. Editing a `.tex` file (or any `\input`-ed file) triggers, within ~5 seconds:
   - Edits sync to the backend.
   - The supertex process resumes from its checkpoint just before the edited byte
     and compiles **only as far as the page currently visible in the right panel**.
   - The new PDF bytes for that page are streamed to the browser, which patches
     the in-memory PDF and re-renders the affected page.
5. Projects persist across sessions. Multiple projects per user, listed on a
   simple dashboard.
6. **Continuous deployment**: pushing to `main` on `github.com/jamievicary/tex.center`
   redeploys the live site automatically.

### Explicitly out of scope for MVP

- Real-time multi-user collaboration (but the wire protocol must not preclude it).
- Billing / subscriptions / usage limits.
- Anonymous / shareable project URLs.
- Sentry, analytics, error reporting beyond server logs.
- Git import/export, Overleaf import.
- Mobile-optimised UI.

## Architecture

### Topology

- **Per-project Fly Machine** (option (a) in the design discussion). One Machine
  is started lazily when a project is opened, runs the supertex daemon plus a
  thin per-project sidecar, and **auto-stops after ~10 min idle**. State is
  rehydrated from Tigris on cold start.
- **Control-plane web app** (always-on, minimum-size Fly Machine, scales to zero
  when nobody is logged in) handles auth, the dashboard, the editor shell, and
  routes WebSocket connections to the right project Machine.

### Storage

- **Postgres** (Fly Postgres): users, sessions, projects, file metadata, machine
  assignments.
- **Tigris (S3-compatible, on Fly)**: project file snapshots, uploaded assets
  (images, `.bib`, `.cls`, …), supertex checkpoint blobs, and the incremental
  PDF segments per project.

### Edit sync protocol

- WebSocket between browser and the per-project Machine.
- **Yjs** carries document state. Single-user MVP, but Yjs gives us a robust
  ops protocol with sequence/ack semantics and leaves the door open for future
  collaboration with no rewrite.
- The client also sends a lightweight **"viewing page N"** signal (debounced)
  whenever the visible page in the PDF preview changes.

### PDF delivery

- supertex emits a **valid PDF after every shipout**, by design.
- After each compile, the backend reports to the client: "PDF length is now `L`,
  here are byte ranges `[a..b]` you don't have." The client appends/patches its
  in-memory PDF buffer and asks PDF.js to re-render the changed pages.
- The backend stops compiling as soon as page N has been shipped (where N is
  the page the user is currently viewing). Later pages are recompiled on demand
  when the user scrolls.

## Tech stack

- **Frontend**: SvelteKit + TypeScript, CodeMirror 6 (with a LaTeX language
  package), PDF.js, Yjs.
- **Backend**: Node.js + TypeScript + Fastify. WebSocket via `ws` or
  `@fastify/websocket`. Yjs server bindings.
- **Native**: supertex (C) as a child process of the per-project sidecar,
  communicating over stdin/stdout or a UNIX socket.
- **Database**: Postgres (Fly Postgres). Drizzle ORM.
- **Object storage**: Tigris (S3 API) via the AWS SDK.
- **Auth**: Google OAuth 2.0 (Authorization Code flow). Server-side sessions
  in Postgres, signed httpOnly cookies. **Hardcoded allowlist:
  `jamievicary@gmail.com`** — all other identities rejected post-OAuth.
- **Container**: Debian-based image with **full TeX Live** plus supertex built
  from the submodule.
- **Hosting**: Fly.io (control-plane Machine + per-project Machines + Postgres
  + Tigris).
- **CI/CD**: GitHub Actions → `flyctl deploy` on push to `main`.

## supertex integration

`supertex` lives at `vendor/supertex` as a **git submodule** of
`github.com/jamievicary/supertex`. The autodev engineer should expect to **send
PRs to the supertex repo** as part of this work — supertex is in an early state
and the following capabilities likely need to be added or extended:

1. A long-running daemon mode that accepts edit operations
   ("file F changed at byte offset X, new bytes Y") on stdin or a socket and
   resumes compilation incrementally.
2. A "ship until page N, then pause" mode so the backend can avoid wasted work
   on pages the user isn't looking at.
3. Per-shipout reporting of which byte ranges of the output PDF changed, so the
   backend can forward minimal diffs to the client.
4. Robust checkpoint serialisation to a single blob (for offload to Tigris on
   Machine idle-stop, and rehydration on cold start).

If any of these turn out to already exist, great — verify and use them. If they
don't, extend supertex itself rather than wrapping its limitations from the
outside.

## External services & credentials

**The autodev engineer is authorised, and expected, to use these credentials
to run live commands against the named services as part of ordinary
iterations** — `flyctl <anything>` against Fly, `gh secret set` /
`gh api ...` against GitHub, `curl` against Cloudflare's API, etc. Doing
so is not "out-of-tree" work; it is the work. The credentials below exist
specifically so the engineer does not need to ask the user to perform any
step manually.

The autodev engineer should look in `creds/` (gitignored) for:

- `creds/fly.token` — Fly.io API token. Provisions Machines, Postgres, Tigris,
  secrets, deploys.
- `creds/google-oauth.json` — `{ "client_id": "...", "client_secret": "..." }`
  for the Google OAuth app. Authorized redirect URIs must include
  `https://tex.center/auth/google/callback` and
  `http://localhost:3000/auth/google/callback`.
- `creds/cloudflare.token` — Cloudflare API token (DNS edit on `tex.center`),
  used to point the apex at Fly and complete the cert handshake automatically.
  *(If the user opts out of Cloudflare, autodev should print the DNS records
  Fly requires and pause for the user to add them manually.)*
- `creds/github.token` — GitHub PAT with `repo` and `workflow` scope, used to
  push code, create the Actions workflow, and set `FLY_API_TOKEN` as an Actions
  secret on `github.com/jamievicary/tex.center`.

If any credential is missing, autodev should **stop and tell the user exactly
which file to create and what scopes/permissions it needs**, rather than
guessing or skipping the step.

## Repository

- **GitHub**: `github.com/jamievicary/tex.center` (already exists, currently
  empty). This working directory is the local checkout.
- **Submodule**: `vendor/supertex` → `github.com/jamievicary/supertex`.
- `creds/` and any `.env*` files must be gitignored from the start.

## Deployment

- Production: `https://tex.center`, deployed automatically from `main`.
- Staging: not required for MVP. A single deploy target is fine.
- Local dev: `npm run dev` (or pnpm) should bring up the full stack against a
  local Postgres + a local supertex build, with a Google OAuth dev client
  pointing at `localhost:3000`.

## Acceptance criteria

The project is "launched" when **all of the following are true**:

1. `https://tex.center` resolves and serves a white page with only a Google
   login button to logged-out visitors.
2. Logging in as `jamievicary@gmail.com` reveals the dashboard; logging in as
   any other Google account is rejected and returns to the white page.
3. The authenticated user can create a project, upload `.tex` files, edit them
   in the browser, and see a PDF preview update within a few seconds of typing.
4. While viewing page N, an edit on an earlier page causes only the necessary
   recompilation (verified by server logs / supertex telemetry showing the
   compile stopped at page N).
5. The PDF wire transfer for an edit that affects only one shipout is on the
   order of the size of that shipout's PDF delta, not the size of the full PDF.
6. Closing the browser and reopening the project later restores the same files,
   the same compiled PDF, and the same supertex checkpoint state.
7. A push to `main` on the GitHub repo triggers a successful Fly deploy that
   updates the live site without manual intervention.
