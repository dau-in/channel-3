/**
 * Time rewind: keep a ring of emulator snapshots taken every INTERVAL
 * frames. Holding the rewind key pops snapshots back in time at a few
 * times real speed.
 */
export const REWIND_INTERVAL = 30; // frames between snapshots (~2/s — each
// snapshot deep-clones the core on the main thread, so cadence is a perf knob)

const MAX_SNAPSHOTS = 120; // 120 * 30 frames ≈ 60 s of history

export class RewindBuffer {
  private ring: unknown[] = [];

  push(snap: unknown): void {
    this.ring.push(snap);
    if (this.ring.length > MAX_SNAPSHOTS) this.ring.shift();
  }

  pop(): unknown | undefined {
    // Keep the oldest snapshot so rewinding past the end holds the frame
    // instead of going black.
    if (this.ring.length > 1) return this.ring.pop();
    return this.ring[0];
  }

  clear(): void {
    this.ring = [];
  }

  get size(): number {
    return this.ring.length;
  }
}
