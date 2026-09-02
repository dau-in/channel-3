// NES pad bitmask, bit index = jsnes Controller.BUTTON_* constant.
export const BTN = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
} as const;

export type Action = "up" | "down" | "left" | "right" | "a" | "b" | "select" | "start";
export const ACTIONS: Action[] = ["up", "down", "left", "right", "a", "b", "select", "start"];
const ACTION_BIT: Record<Action, number> = {
  up: BTN.UP,
  down: BTN.DOWN,
  left: BTN.LEFT,
  right: BTN.RIGHT,
  a: BTN.A,
  b: BTN.B,
  select: BTN.SELECT,
  start: BTN.START,
};

/** Actions that are not NES buttons: they drive the emulator itself, so they
 *  live outside the pad bitmask and are shared by both players. */
export type SysAction = "rewind" | "save" | "load" | "pause";
export const SYS_ACTIONS: SysAction[] = ["rewind", "save", "load", "pause"];

/** A pad binding is a button index — or an axis direction encoded above this
 *  base. Plenty of controllers report the d-pad as a hat on an axis instead of
 *  as buttons, and the old capture only ever looked at `buttons[]`, so on those
 *  the d-pad simply could not be bound: pressing it did nothing at all.
 *  Encoding axes as numbers keeps the stored shape a `number[]`, so binds
 *  saved by earlier versions stay valid. */
export const AXIS_BASE = 1000;
/** Deflection that counts as pressed. */
const AXIS_ON = 0.55;

export const axisCode = (axis: number, positive: boolean): number =>
  AXIS_BASE + axis * 2 + (positive ? 1 : 0);
export const isAxisCode = (code: number): boolean => code >= AXIS_BASE;
export const decodeAxis = (code: number): { axis: number; positive: boolean } => ({
  axis: (code - AXIS_BASE) >> 1,
  positive: ((code - AXIS_BASE) & 1) === 1,
});

function codeActive(gp: Gamepad, code: number): boolean {
  if (!isAxisCode(code)) return gp.buttons[code]?.pressed ?? false;
  const { axis, positive } = decodeAxis(code);
  const v = gp.axes[axis] ?? 0;
  return positive ? v > AXIS_ON : v < -AXIS_ON;
}

export interface SysBinds {
  key: Record<SysAction, string[]>;
  pad: Record<SysAction, number[]>;
}

export function defaultSysBinds(): SysBinds {
  return {
    key: { rewind: ["Backspace"], save: ["KeyK"], load: ["KeyL"], pause: ["KeyP"] },
    // Hold either shoulder to rewind, click a stick to save or load. None of
    // these exist on a NES pad, so binding them takes nothing from the game.
    pad: { rewind: [4, 5], save: [10], load: [11], pause: [] },
  };
}

/** A player's controls: keyboard codes and gamepad button indices per action. */
export interface Binds {
  key: Record<Action, string[]>;
  pad: Record<Action, number[]>;
}

export function defaultBinds(player: 0 | 1): Binds {
  // Standard gamepad layout: east/north = A, south/west = B, mirroring the
  // physical NES controller; both players default to the same pad mapping.
  const pad: Record<Action, number[]> = {
    a: [1, 3],
    b: [0, 2],
    select: [8],
    start: [9],
    up: [12],
    down: [13],
    left: [14],
    right: [15],
  };
  const key: Record<Action, string[]> =
    player === 0
      ? {
          up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"],
          a: ["KeyX"], b: ["KeyZ"], select: ["ShiftLeft", "ShiftRight"], start: ["Enter"],
        }
      : {
          up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"],
          a: ["KeyE"], b: ["KeyQ"], select: ["Digit1"], start: ["Digit2"],
        };
  return { key, pad };
}

export class Input {
  private keyBits: [number, number] = [0, 0];
  private touchBits = 0; // on-screen mobile pad, folded into player 1
  private binds: [Binds, Binds] = [defaultBinds(0), defaultBinds(1)];
  private sysBinds: SysBinds = defaultSysBinds();
  private sysHeld: Record<SysAction, boolean> = {
    rewind: false, save: false, load: false, pause: false,
  };
  private keyLookup: [Record<string, number>, Record<string, number>] = [{}, {}];
  rewindHeld = false;
  onHotkey: ((key: "pause" | "save" | "load") => void) | null = null;

  constructor() {
    this.rebuild();
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
  }

  getBinds(): [Binds, Binds] {
    return this.binds;
  }
  setBinds(b: [Binds, Binds]): void {
    this.binds = b;
    this.rebuild();
  }
  setKeyBind(player: 0 | 1, action: Action, code: string): void {
    this.binds[player].key[action] = [code];
    this.rebuild();
  }
  setPadBind(player: 0 | 1, action: Action, index: number): void {
    this.binds[player].pad[action] = [index];
  }

  getSysBinds(): SysBinds {
    return this.sysBinds;
  }
  setSysBinds(b: SysBinds): void {
    this.sysBinds = b;
  }
  setSysKeyBind(action: SysAction, code: string): void {
    this.sysBinds.key[action] = [code];
  }
  setSysPadBind(action: SysAction, code: number): void {
    this.sysBinds.pad[action] = [code];
  }

  /** Rebuild the fast code→bit lookup after any keyboard binding change. */
  private rebuild(): void {
    for (const p of [0, 1] as const) {
      const lut: Record<string, number> = {};
      for (const a of ACTIONS) for (const code of this.binds[p].key[a]) lut[code] = ACTION_BIT[a];
      this.keyLookup[p] = lut;
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement && e.target.type === "text") return;

    for (const p of [0, 1] as const) {
      const bit = this.keyLookup[p][e.code];
      if (bit !== undefined) {
        if (down) this.keyBits[p] |= bit;
        else this.keyBits[p] &= ~bit;
        e.preventDefault();
        return;
      }
    }

    // System actions are bindings too now, not hardcoded keys.
    for (const a of SYS_ACTIONS) {
      if (!this.sysBinds.key[a].includes(e.code)) continue;
      e.preventDefault();
      if (a === "rewind") {
        this.rewindHeld = down;
      } else if (down && !e.repeat && this.onHotkey) {
        this.onHotkey(a);
      }
      return;
    }
  }

  // --- on-screen touch pad (player 1 only) ---
  /** Replace the d-pad portion of the touch state (supports diagonals). */
  setTouchDir(dirBits: number): void {
    const DIRS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;
    this.touchBits = (this.touchBits & ~DIRS) | (dirBits & DIRS);
  }
  setTouchButton(bit: number, down: boolean): void {
    if (down) this.touchBits |= bit;
    else this.touchBits &= ~bit;
  }
  clearTouch(): void {
    this.touchBits = 0;
  }

  /** Combined keyboard + first-gamepad + touch state as a pad bitmask. */
  poll(): number {
    return this.keyBits[0] | this.pollGamepad(0) | this.touchBits;
  }

  /** Local player 2: their keyboard cluster (and a second gamepad, if present). */
  poll2(): number {
    return this.keyBits[1] | this.pollGamepad(1);
  }

  /** Gamepad only — for UI navigation, where keyboard has its own handler. */
  pollGamepad(skip = 0): number {
    const pads = navigator.getGamepads?.();
    const connected = pads ? Array.from(pads).filter((p) => p && p.connected) : [];
    const gp = connected[skip];
    if (!gp) return 0;

    const map = this.binds[skip >= 1 ? 1 : 0].pad;
    let bits = 0;
    for (const a of ACTIONS) {
      for (const code of map[a]) {
        if (codeActive(gp, code)) {
          bits |= ACTION_BIT[a];
          break;
        }
      }
    }

    // analog stick always doubles as the d-pad
    const x = gp.axes[0] ?? 0;
    const y = gp.axes[1] ?? 0;
    if (x < -0.5) bits |= BTN.LEFT;
    if (x > 0.5) bits |= BTN.RIGHT;
    if (y < -0.5) bits |= BTN.UP;
    if (y > 0.5) bits |= BTN.DOWN;

    return bits;
  }

  private padAt(skip: number): Gamepad | undefined {
    const pads = navigator.getGamepads?.();
    const connected = pads ? Array.from(pads).filter((p) => p && p.connected) : [];
    return connected[skip] ?? undefined;
  }

  /** What the pad reports about itself. A pad whose `mapping` is not
   *  "standard" has arbitrary button indices, so the defaults are meaningless
   *  on it and the player has to bind their own — the UI says so. */
  padInfo(skip = 0): { id: string; standard: boolean; buttons: number; axes: number } | null {
    const gp = this.padAt(skip);
    if (!gp) return null;
    return {
      id: gp.id,
      standard: gp.mapping === "standard",
      buttons: gp.buttons.length,
      axes: gp.axes.length,
    };
  }

  /** Axis values right now, to be used as the resting baseline of a capture. */
  padAxisRest(skip = 0): number[] {
    return Array.from(this.padAt(skip)?.axes ?? []);
  }

  /** Whatever is being pressed on gamepad `skip` — a button index, or an axis
   *  direction encoded above AXIS_BASE — or -1.
   *
   *  `rest` is where the axes sat when the capture opened. Without it this
   *  fires instantly on any pad whose triggers rest at -1 (most of them),
   *  binding a trigger the moment you click the cell. */
  pressedPadInput(skip = 0, rest: number[] = []): number {
    const gp = this.padAt(skip);
    if (!gp) return -1;
    for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i]?.pressed) return i;
    for (let i = 0; i < gp.axes.length; i++) {
      const v = gp.axes[i] ?? 0;
      const base = rest[i] ?? 0;
      if (Math.abs(v) > AXIS_ON && Math.abs(v - base) > 0.6) return axisCode(i, v > 0);
    }
    return -1;
  }

  /** Gamepad half of the system actions. Called once per frame: rewind is a
   *  hold, the rest fire on the press edge so one click is one save. */
  pollSys(): void {
    const gp = this.padAt(0);
    for (const a of SYS_ACTIONS) {
      const on = gp ? this.sysBinds.pad[a].some((c) => codeActive(gp, c)) : false;
      const was = this.sysHeld[a];
      this.sysHeld[a] = on;
      if (a === "rewind") {
        if (on) this.rewindHeld = true;
        else if (was) this.rewindHeld = false;
      } else if (on && !was && this.onHotkey) {
        this.onHotkey(a);
      }
    }
  }
}
