import Peer, { DataConnection } from "peerjs";

/**
 * P2P netplay via WebRTC (peerjs) using deterministic frame lockstep:
 * both peers run their own jsnes core and exchange only controller bytes.
 * Local input for frame F is scheduled at F+DELAY (hiding network latency)
 * and a frame only advances when both pads for it are known, so the two
 * simulations can never diverge. Host is player 1, guest is player 2.
 */

const INPUT_DELAY = 3; // frames (~50 ms) of latency hiding
const ID_PREFIX = "channel3-v1-";
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

type Msg =
  | { t: "rom"; name: string; data: ArrayBuffer }
  | { t: "ready" }
  | { t: "start" }
  | { t: "input"; f: number; b: number };

export type Role = "host" | "guest";

export interface NetplayEvents {
  onStatus: (text: string) => void;
  /** Host side: a guest connected; send the ROM via sendRom(). */
  onPeerConnected: () => void;
  /** Guest side: host's ROM arrived; load it, then netplay sends "ready". */
  onRom: (name: string, bytes: Uint8Array) => void;
  /** Both sides: reset the core and begin lockstep at frame 0. */
  onStart: () => void;
  onStop: (reason: string) => void;
}

export class Netplay {
  role: Role | null = null;
  frame = 0;

  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private local = new Map<number, number>();
  private remote = new Map<number, number>();
  private started = false;

  constructor(private events: NetplayEvents) {}

  get active(): boolean {
    return this.started;
  }

  get connected(): boolean {
    return this.conn?.open ?? false;
  }

  host(): Promise<string> {
    this.dispose();
    const code = Array.from(
      { length: 6 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
    ).join("");

    return new Promise((resolve, reject) => {
      const peer = new Peer(ID_PREFIX + code);
      this.peer = peer;
      this.role = "host";
      peer.on("open", () => {
        this.events.onStatus(`Hosting — waiting for peer`);
        resolve(code);
      });
      peer.on("error", (err) => {
        this.events.onStatus(`Error: ${err.type}`);
        reject(err);
      });
      peer.on("connection", (conn) => {
        if (this.conn) {
          conn.close();
          return;
        }
        this.setupConn(conn);
      });
    });
  }

  join(code: string): void {
    this.dispose();
    const peer = new Peer();
    this.peer = peer;
    this.role = "guest";
    this.events.onStatus("Connecting…");
    peer.on("open", () => {
      const conn = peer.connect(ID_PREFIX + code.toUpperCase().trim(), {
        reliable: true,
      });
      this.setupConn(conn);
    });
    peer.on("error", (err) => this.events.onStatus(`Error: ${err.type}`));
  }

  /** Host calls this once its peer is connected, to ship the ROM. */
  sendRom(name: string, bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.send({ t: "rom", name, data: copy.buffer });
  }

  /** Guest calls this after loading the received ROM. */
  sendReady(): void {
    this.send({ t: "ready" });
  }

  /** True when the lockstep can advance to the current frame. */
  canStep(): boolean {
    return this.started && this.remote.has(this.frame) && this.local.has(this.frame);
  }

  /**
   * Advance one lockstep frame: schedule + send the local pad for
   * frame+DELAY, return both pads for the current frame mapped to players.
   */
  step(localPad: number): { p1: number; p2: number } {
    const scheduled = this.frame + INPUT_DELAY;
    if (!this.local.has(scheduled)) {
      this.local.set(scheduled, localPad);
      this.send({ t: "input", f: scheduled, b: localPad });
    }

    const mine = this.local.get(this.frame)!;
    const theirs = this.remote.get(this.frame)!;
    this.local.delete(this.frame - 1);
    this.remote.delete(this.frame - 1);
    this.frame++;

    return this.role === "host" ? { p1: mine, p2: theirs } : { p1: theirs, p2: mine };
  }

  stop(reason = "Disconnected"): void {
    const wasActive = this.started || this.connected;
    this.dispose();
    if (wasActive) this.events.onStop(reason);
  }

  private setupConn(conn: DataConnection): void {
    this.conn = conn;
    conn.on("open", () => {
      this.events.onStatus("Peer connected");
      if (this.role === "host") this.events.onPeerConnected();
    });
    conn.on("data", (data) => this.onMessage(data as Msg));
    conn.on("close", () => this.stop("Peer disconnected"));
    conn.on("error", () => this.stop("Connection error"));
  }

  private onMessage(msg: Msg): void {
    if (msg.t !== "input") console.debug("[netplay] recv", msg.t);
    switch (msg.t) {
      case "rom":
        this.events.onRom(msg.name, new Uint8Array(msg.data));
        break;
      case "ready":
        // Guest is loaded; host starts both sides. Idempotent: a repeated
        // "ready" just re-sends "start" in case the guest missed it.
        this.send({ t: "start" });
        this.begin();
        break;
      case "start":
        this.begin();
        break;
      case "input":
        this.remote.set(msg.f, msg.b);
        break;
    }
  }

  private begin(): void {
    if (this.started) return;
    this.frame = 0;
    this.local.clear();
    this.remote.clear();
    for (let f = 0; f < INPUT_DELAY; f++) {
      this.local.set(f, 0);
      this.remote.set(f, 0);
    }
    this.started = true;
    this.events.onStatus(`Netplay live — you are ${this.role === "host" ? "P1" : "P2"}`);
    this.events.onStart();
  }

  private send(msg: Msg): void {
    if (msg.t !== "input") console.debug("[netplay] send", msg.t, "open:", this.conn?.open);
    this.conn?.send(msg);
  }

  private dispose(): void {
    this.started = false;
    this.role = null;
    this.frame = 0;
    this.local.clear();
    this.remote.clear();
    this.conn?.close();
    this.conn = null;
    this.peer?.destroy();
    this.peer = null;
  }
}
