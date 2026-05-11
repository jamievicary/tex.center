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
}

export interface WsClientOptions {
  url: string;
  onChange?: (snap: WsClientSnapshot) => void;
}

export class WsClient {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  private socket: WebSocket | null = null;
  private readonly pdf = new PdfBuffer();
  private readonly onChange: ((snap: WsClientSnapshot) => void) | undefined;
  private readonly url: string;
  private _status: ConnectionState = "connecting";
  private _pdfBytes: Uint8Array | null = null;
  private _lastError: string | null = null;
  private _compileState: WsClientSnapshot["compileState"] = "unknown";
  private _files: string[] = [MAIN_DOC_NAME];
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(opts: WsClientOptions) {
    this.url = opts.url;
    this.onChange = opts.onChange;
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
        break;
      case "pdf-segment":
        this._pdfBytes = this.pdf.applySegment(decoded.segment);
        this.emit();
        break;
      case "control":
        if (decoded.message.type === "compile-status") {
          this._compileState = decoded.message.state;
          if (decoded.message.state === "error") {
            this._lastError = decoded.message.detail ?? "compile error";
          }
          this.emit();
        } else if (decoded.message.type === "file-list") {
          this._files = decoded.message.files;
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
