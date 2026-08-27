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

    if (e.code === "Backspace") {
      this.rewindHeld = down;
      e.preventDefault();
      return;
    }

    if (down && !e.repeat && this.onHotkey) {
      if (e.code === "KeyP") this.onHotkey("pause");
      else if (e.code === "KeyK") this.onHotkey("save");
      else if (e.code === "KeyL") this.onHotkey("load");
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
      for (const i of map[a]) {
        if (gp.buttons[i]?.pressed) {
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

  /** Index of any currently-pressed button on gamepad `skip`, or -1 (for the
   *  remap capture flow). */
  pressedPadButton(skip = 0): number {
    const pads = navigator.getGamepads?.();
    const connected = pads ? Array.from(pads).filter((p) => p && p.connected) : [];
    const gp = connected[skip];
    if (!gp) return -1;
    for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i]?.pressed) return i;
    return -1;
  }
}
