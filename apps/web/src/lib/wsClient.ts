// Per-project WebSocket client. Owns one Y.Doc, decodes binary
// frames using the shared protocol package, and exposes a small
// reactive surface (status, pdfBytes, lastError) that callers can
// read with Svelte 5 runes via the getters or via the
// `subscribe(fn)` callback.
//
// Outbound: local Y.Doc updates (origin !== this client) are
// encoded as `doc-update` and sent. `setViewingPage(n)` sends a
// `view` control message.

import * as Y from "yjs";

import {
  MAIN_DOC_NAME,
  decodeFrame,
  encodeControl,
  encodeDocUpdate,
} from "@tex-center/protocol";

import { PdfBuffer } from "./pdfBuffer";
import { errorMessage } from "./errors";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export interface WsClientSnapshot {
  status: ConnectionState;
  pdfBytes: Uint8Array | null;
  /**
   * Tri-state echo of the most recent `pdf-segment.lastPage` field
   * (iter-370 wire). `true` ⇒ the daemon reached `\enddocument` on
   * that round and no further pages will be produced; `false` ⇒ the
   * round stopped short of `\enddocument`, more pages exist past the
   * current shipout, and the FE should render a demand-fetch
   * placeholder for page N+1. `undefined` ⇒ the compiler does not
   * expose the signal (e.g. `FixtureCompiler`) — FE leaves the
   * placeholder slot closed (the legacy "ship every page" model
   * applies in that case, so there's no missing page to fetch).
   */
  pdfLastPage: boolean | undefined;
  lastError: string | null;
  compileState: "idle" | "running" | "error" | "unknown";
  files: string[];
  /**
   * Last server-side rejection of a file-tree op (create / delete /
   * rename) initiated by this client. Cleared on the next
   * `file-list` (which only arrives after a successful op).
   */
  fileOpError: string | null;
  /**
   * `true` once the first authoritative server frame has been
   * applied to the local Y.Doc — either a `doc-update` (Yjs
   * initial-sync) or a `file-list` control. Editor UI gates
   * CodeMirror mount on this to avoid the empty-buffer flash
   * described in GT-A.
   */
  hydrated: boolean;
}

/**
 * Wire-level event surfaced for the debug-mode protocol fan-out
 * (M9.editor-ux debug toasts; see `.autodev/discussion/
 * 174_answer.md`). Fires once per observed frame irrespective of
 * snapshot transitions, so toast aggregation keys can coalesce
 * bursts without the WsClient deduping at the source.
 */
export type WsDebugEvent =
  | { kind: "pdf-segment"; bytes: number; shipoutPage?: number }
  | {
      kind: "compile-status";
      state: "idle" | "running" | "error" | "unknown";
      detail?: string;
    }
  | { kind: "file-list"; count: number }
  | { kind: "hello"; protocol: number }
  | { kind: "file-op-error"; reason: string }
  | { kind: "outgoing-doc-update"; bytes: number }
  | { kind: "outgoing-viewing-page"; page: number }
  | { kind: "outgoing-create-file"; name: string }
  | { kind: "outgoing-upload-file"; name: string; bytes: number }
  | { kind: "outgoing-delete-file"; name: string }
  | { kind: "outgoing-rename-file"; oldName: string; newName: string };

export interface WsClientOptions {
  url: string;
  onChange?: (snap: WsClientSnapshot) => void;
  /**
   * Fired on every `file-op-error` control frame, regardless of
   * whether the reason matches a previous one. Toast consumers
   * dedup repeats via the toast store's aggregateKey rather than
   * by snapshot-transition edge detection, so back-to-back
   * identical errors must each surface here.
   */
  onFileOpError?: (reason: string) => void;
  /**
   * Fired on every `compile-status` control frame whose `state`
   * is `"error"`. `detail` is the server-supplied diagnostic, or
   * `"compile error"` when the frame omits one.
   */
  onCompileError?: (detail: string) => void;
  /**
   * Fired once per observed wire event when the editor enables
   * debug mode. Always fires when supplied; consumers gate
   * subscription on the `?debug=1` flag.
   */
  onDebugEvent?: (event: WsDebugEvent) => void;
}

export class WsClient {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  private socket: WebSocket | null = null;
  private readonly pdf = new PdfBuffer();
  private readonly onChange: ((snap: WsClientSnapshot) => void) | undefined;
  private readonly onFileOpError: ((reason: string) => void) | undefined;
  private readonly onCompileError: ((detail: string) => void) | undefined;
  private readonly onDebugEvent: ((event: WsDebugEvent) => void) | undefined;
  private readonly url: string;
  private _status: ConnectionState = "connecting";
  private _pdfBytes: Uint8Array | null = null;
  private _pdfLastPage: boolean | undefined = undefined;
  private _lastError: string | null = null;
  private _compileState: WsClientSnapshot["compileState"] = "unknown";
  private _files: string[] = [MAIN_DOC_NAME];
  private _fileOpError: string | null = null;
  private _hydrated = false;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(opts: WsClientOptions) {
    this.url = opts.url;
    this.onChange = opts.onChange;
    this.onFileOpError = opts.onFileOpError;
    this.onCompileError = opts.onCompileError;
    this.onDebugEvent = opts.onDebugEvent;
    this.doc = new Y.Doc();
    this.text = this.doc.getText(MAIN_DOC_NAME);
    this.onDocUpdate = (update, origin) => {
      if (origin === this) return;
      const sent = this.send(encodeDocUpdate(update));
      if (sent) {
        this.onDebugEvent?.({
          kind: "outgoing-doc-update",
          bytes: update.byteLength,
        });
      }
    };
    this.doc.on("update", this.onDocUpdate);
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.socket = ws;
    ws.addEventListener("open", () => {
      this._status = "open";
      this.emit();
    });
    ws.addEventListener("close", () => {
      this._status = "closed";
      this.emit();
    });
    ws.addEventListener("error", () => {
      this._status = "error";
      this._lastError = "websocket error";
      this.emit();
    });
    ws.addEventListener("message", (ev) => {
      this.handleMessage(ev.data);
    });
  }

  private handleMessage(data: unknown): void {
    let frame: Uint8Array;
    if (data instanceof ArrayBuffer) {
      frame = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      frame = data;
    } else {
      this._lastError = "non-binary frame";
      this.emit();
      return;
    }
    let decoded;
    try {
      decoded = decodeFrame(frame);
    } catch (e) {
      const msg = errorMessage(e);
      this._lastError = msg;
      // Iter 356: a stale per-project sidecar image (pre-M22.4b
      // 17-byte pdf-segment header) silently truncates the
      // decoded `bytes` and throws "pdf-segment payload truncated"
      // here — the WS layer used to swallow it, hiding the
      // protocol-drift symptom from the iter-355 fixture's
      // console.error capture. Surface decode errors at error
      // level so future wire-protocol drift fails loudly.
      // eslint-disable-next-line no-console
      console.error("[WsClient] decodeFrame failed:", msg);
      this.emit();
      return;
    }
    switch (decoded.kind) {
      case "doc-update":
        Y.applyUpdate(this.doc, decoded.update, this);
        if (!this._hydrated) {
          this._hydrated = true;
          this.emit();
        }
        break;
      case "pdf-segment":
        this._pdfBytes = this.pdf.applySegment(decoded.segment);
        this._pdfLastPage = decoded.segment.lastPage;
        {
          const ev: WsDebugEvent =
            decoded.segment.shipoutPage !== undefined
              ? {
                  kind: "pdf-segment",
                  bytes: decoded.segment.bytes.byteLength,
                  shipoutPage: decoded.segment.shipoutPage,
                }
              : {
                  kind: "pdf-segment",
                  bytes: decoded.segment.bytes.byteLength,
                };
          this.onDebugEvent?.(ev);
        }
        this.emit();
        break;
      case "control":
        if (decoded.message.type === "compile-status") {
          this._compileState = decoded.message.state;
          if (decoded.message.state === "error") {
            const detail = decoded.message.detail ?? "compile error";
            this._lastError = detail;
            this.onCompileError?.(detail);
          }
          {
            const ev: WsDebugEvent =
              decoded.message.detail !== undefined
                ? {
                    kind: "compile-status",
                    state: decoded.message.state,
                    detail: decoded.message.detail,
                  }
                : { kind: "compile-status", state: decoded.message.state };
            this.onDebugEvent?.(ev);
          }
          this.emit();
        } else if (decoded.message.type === "file-list") {
          this._files = decoded.message.files;
          this._fileOpError = null;
          this._hydrated = true;
          this.onDebugEvent?.({
            kind: "file-list",
            count: decoded.message.files.length,
          });
          this.emit();
        } else if (decoded.message.type === "file-op-error") {
          this._fileOpError = decoded.message.reason;
          this.onFileOpError?.(decoded.message.reason);
          this.onDebugEvent?.({
            kind: "file-op-error",
            reason: decoded.message.reason,
          });
          this.emit();
        } else if (decoded.message.type === "hello") {
          this.onDebugEvent?.({
            kind: "hello",
            protocol: decoded.message.protocol,
          });
        }
        break;
      case "awareness":
        break;
    }
  }

  private send(frame: Uint8Array): boolean {
    const s = this.socket;
    if (!s || s.readyState !== s.OPEN) return false;
    s.send(frame);
    return true;
  }

  setViewingPage(page: number): void {
    const sent = this.send(encodeControl({ type: "view", page }));
    if (sent) this.onDebugEvent?.({ kind: "outgoing-viewing-page", page });
  }

  /**
   * Ask the sidecar to create a new file in this project. The
   * server validates the name and broadcasts a refreshed
   * `file-list` on success; rejected names produce no visible
   * change (a warning is logged server-side).
   */
  createFile(name: string): void {
    const sent = this.send(encodeControl({ type: "create-file", name }));
    if (sent) this.onDebugEvent?.({ kind: "outgoing-create-file", name });
  }

  /**
   * Upload a text file's contents under `name`. Server validates
   * the name and rejects duplicates; success broadcasts a refreshed
   * `file-list` and the populated `Y.Text` arrives via doc-update.
   */
  uploadFile(name: string, content: string): void {
    const sent = this.send(encodeControl({ type: "upload-file", name, content }));
    if (sent) {
      this.onDebugEvent?.({
        kind: "outgoing-upload-file",
        name,
        bytes: new TextEncoder().encode(content).byteLength,
      });
    }
  }

  /**
   * Ask the sidecar to delete a project file. The server rejects
   * `MAIN_DOC_NAME` and unknown names; on success it broadcasts a
   * refreshed `file-list`.
   */
  deleteFile(name: string): void {
    const sent = this.send(encodeControl({ type: "delete-file", name }));
    if (sent) this.onDebugEvent?.({ kind: "outgoing-delete-file", name });
  }

  /**
   * Ask the sidecar to rename a project file. The server rejects
   * `MAIN_DOC_NAME` on either side, unknown names, invalid new
   * names, and duplicates; on success it broadcasts a refreshed
   * `file-list`.
   */
  renameFile(oldName: string, newName: string): void {
    const sent = this.send(encodeControl({ type: "rename-file", oldName, newName }));
    if (sent) {
      this.onDebugEvent?.({
        kind: "outgoing-rename-file",
        oldName,
        newName,
      });
    }
  }

  /**
   * Returns the `Y.Text` for a given filename on the project doc.
   * Each persisted file is hydrated by the server into
   * `doc.getText(<relative-path>)`; calling this with an unknown
   * name still returns a (possibly-empty) `Y.Text` because Yjs
   * auto-creates the type on first access.
   */
  getText(name: string): Y.Text {
    return this.doc.getText(name);
  }

  snapshot(): WsClientSnapshot {
    return {
      status: this._status,
      pdfBytes: this._pdfBytes,
      pdfLastPage: this._pdfLastPage,
      lastError: this._lastError,
      compileState: this._compileState,
      files: this._files,
      fileOpError: this._fileOpError,
      hydrated: this._hydrated,
    };
  }

  private emit(): void {
    this.onChange?.(this.snapshot());
  }

  destroy(): void {
    this.doc.off("update", this.onDocUpdate);
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      this.socket.close();
    }
    this.socket = null;
    this.doc.destroy();
  }
}
