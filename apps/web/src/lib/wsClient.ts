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

export type ConnectionState = "connecting" | "open" | "closed" | "error";

export interface WsClientSnapshot {
  status: ConnectionState;
  pdfBytes: Uint8Array | null;
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
}

export class WsClient {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  private socket: WebSocket | null = null;
  private readonly pdf = new PdfBuffer();
  private readonly onChange: ((snap: WsClientSnapshot) => void) | undefined;
  private readonly onFileOpError: ((reason: string) => void) | undefined;
  private readonly onCompileError: ((detail: string) => void) | undefined;
  private readonly url: string;
  private _status: ConnectionState = "connecting";
  private _pdfBytes: Uint8Array | null = null;
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
    this.doc = new Y.Doc();
    this.text = this.doc.getText(MAIN_DOC_NAME);
    this.onDocUpdate = (update, origin) => {
      if (origin === this) return;
      this.send(encodeDocUpdate(update));
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
      this._lastError = e instanceof Error ? e.message : String(e);
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
          this.emit();
        } else if (decoded.message.type === "file-list") {
          this._files = decoded.message.files;
          this._fileOpError = null;
          this._hydrated = true;
          this.emit();
        } else if (decoded.message.type === "file-op-error") {
          this._fileOpError = decoded.message.reason;
          this.onFileOpError?.(decoded.message.reason);
          this.emit();
        }
        break;
      case "awareness":
        break;
    }
  }

  private send(frame: Uint8Array): void {
    const s = this.socket;
    if (!s || s.readyState !== s.OPEN) return;
    s.send(frame);
  }

  setViewingPage(page: number): void {
    this.send(encodeControl({ type: "view", page }));
  }

  /**
   * Ask the sidecar to create a new file in this project. The
   * server validates the name and broadcasts a refreshed
   * `file-list` on success; rejected names produce no visible
   * change (a warning is logged server-side).
   */
  createFile(name: string): void {
    this.send(encodeControl({ type: "create-file", name }));
  }

  /**
   * Upload a text file's contents under `name`. Server validates
   * the name and rejects duplicates; success broadcasts a refreshed
   * `file-list` and the populated `Y.Text` arrives via doc-update.
   */
  uploadFile(name: string, content: string): void {
    this.send(encodeControl({ type: "upload-file", name, content }));
  }

  /**
   * Ask the sidecar to delete a project file. The server rejects
   * `MAIN_DOC_NAME` and unknown names; on success it broadcasts a
   * refreshed `file-list`.
   */
  deleteFile(name: string): void {
    this.send(encodeControl({ type: "delete-file", name }));
  }

  /**
   * Ask the sidecar to rename a project file. The server rejects
   * `MAIN_DOC_NAME` on either side, unknown names, invalid new
   * names, and duplicates; on success it broadcasts a refreshed
   * `file-list`.
   */
  renameFile(oldName: string, newName: string): void {
    this.send(encodeControl({ type: "rename-file", oldName, newName }));
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
