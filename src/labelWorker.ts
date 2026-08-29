import { scanForLabel } from "./labelScan";

/**
 * Label generation is thousands of emulated frames per ROM. On the main
 * thread it competed with rendering and dropped the gallery to ~20fps on a
 * first visit; here it costs the UI nothing and runs flat out, so it also
 * finishes sooner. Only the frame comes back — the JPEG needs a canvas, which
 * stays on the main thread.
 */
interface Job {
  id: number;
  bytes: Uint8Array;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bytes } = e.data;
  const post = self as unknown as Worker;
  try {
    const found = await scanForLabel(bytes);
    // copy: the scan may hand back the emulator's own live framebuffer, and
    // transferring that detaches a buffer the emulator still has views on
    const rgba = found.slice();
    post.postMessage({ id, rgba }, [rgba.buffer]);
  } catch (err) {
    post.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
