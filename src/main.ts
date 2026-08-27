import { Emulator, NES_WIDTH, NES_HEIGHT } from "./emulator";
import { Renderer } from "./video";
import { AudioPipe } from "./audio";
import { Input, BTN, ACTIONS, defaultBinds, type Action, type Binds } from "./input";
import { RewindBuffer, REWIND_INTERVAL } from "./rewind";
import { Netplay } from "./netplay";
import { loadManifest, fetchRom, type RomEntry } from "./roms";
import { lookupRom } from "./nesdb";
import { cachedLabel, storeLabel, generateLabel } from "./labels";
import {
  addUserRom,
  listUserRoms,
  getUserRom,
  deleteUserRom,
  clearUserRoms,
  storageSummary,
  exportSaves,
  importSaves,
  type UserRom,
} from "./library";
import { sfx, setSfxVolume, setSfxContext } from "./sfx";

// Latin subset only — the UI is all-caps ASCII, so latin-ext would ship two
// more font files nothing renders.
import "@fontsource/silkscreen/latin-400.css";
import "@fontsource/silkscreen/latin-700.css";
import "nes.css/css/nes.min.css";
import "./style.css";

// NTSC NES: 60.0988 Hz. Everything paces off this, not off a rounded 60.
const NES_FPS = 60.0988;
const FRAME_MS = 1000 / NES_FPS;

// Netplay catch-up cap: a stalled peer must not let us run away. Rewind pops
// this many snapshots per tick.
const MAX_CATCHUP_FRAMES = 3;
const REWIND_STEP = 3;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const screenCanvas = $<HTMLCanvasElement>("#screen");
const viewGallery = $("#view-gallery");
const hud = $("#hud");
const viewVs = $("#view-vs");
const viewSettings = $("#view-settings");
const carousel = $("#carousel");
const cartMeta = $("#cart-meta");
const overlay = $("#overlay");
const badge = $("#badge");
const romInput = $<HTMLInputElement>("#rom-input");
const romName = $("#rom-name");
const netStatus = $("#net-status");
const roomCode = $("#room-code");
const hostCode = $("#host-code");
const vsGame = $("#vs-game");
const rewOverlay = $("#rew-overlay");
const toastGamepad = $("#toast-gamepad");
const btnSave = $<HTMLButtonElement>("#btn-save");
const btnLoad = $<HTMLButtonElement>("#btn-load");
const btnHost = $<HTMLButtonElement>("#btn-host");
const stage = $("#stage");
const tvFrame = $("#tv-frame");
const noSignal = $("#no-signal");
const padFloor = $("#pad-floor");
const viewExit = $("#view-exit");
const viewContinue = $("#view-continue");
const viewRemove = $("#view-remove");

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = "channel3-settings";

interface Settings {
  autosave: boolean;
  volume: number;
  theme: string;
  filter: "nearest" | "smooth" | "epx";
  tv: string;
  touch: "auto" | "on" | "off";
  touchSize: string;
  wall: string;
}

const settings: Settings = {
  autosave: true,
  volume: 1,
  theme: "famicom",
  filter: "nearest",
  tv: "full",
  touch: "auto",
  touchSize: "m",
  wall: "diamonds",
};

try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"));
} catch {
  // corrupt blob: fall back to defaults rather than refusing to boot
}

// Options renamed in earlier versions, mapped forward so an existing install
// doesn't come back with a dead theme or an empty TV frame.
if (settings.theme === "amber") settings.theme = "famicom";
if (settings.tv === "monitor" || settings.tv === "shadow" || settings.tv === "frameless") {
  settings.tv = "minimal";
}

function saveSettings(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// -------------------------------------------------------------------- core

const audio = new AudioPipe();
const emu = new Emulator(audio.sampleRate, (l, r) => audio.pushSample(l, r));
const renderer = new Renderer(screenCanvas);
const input = new Input();
const rewind = new RewindBuffer();

type View = "gallery" | "playing";

interface CurrentGame {
  name: string;
  bytes: Uint8Array;
  key: string;
}

let view: View = "gallery";
let game: CurrentGame | null = null;
let paused = false;
let frameCount = 0;
let peerStallFrames = 0;

// --------------------------------------------------------------- tv static

const staticRgba = new Uint8Array(NES_WIDTH * NES_HEIGHT * 4);
const static32 = new Uint32Array(staticRgba.buffer);
let staticBandY = 0;

// Analog snow with a soft band drifting down it, the way an untuned CRT
// rolls. Written through a 32-bit view: one store per pixel, not four.
function genStatic(): void {
  staticBandY = (staticBandY + 2.3) % NES_HEIGHT;
  for (let y = 0; y < NES_HEIGHT; y++) {
    let gain = 0.55 + Math.random() * 0.7;
    const dist = Math.abs(y - staticBandY);
    if (dist < 14) gain *= 0.35 + (dist / 14) * 0.65;
    const spark = Math.random() < 0.008 ? 90 : 0;
    const row = y * NES_WIDTH;
    for (let x = 0; x < NES_WIDTH; x++) {
      const v = Math.min(255, Math.random() * 160 * gain + spark) | 0;
      static32[row + x] = 0xff000000 | (v << 16) | (v << 8) | v;
    }
  }
}

// SMPTE-style bars, built once at boot.
const barsRgba = new Uint8Array(NES_WIDTH * NES_HEIGHT * 4);
{
  const bars32 = new Uint32Array(barsRgba.buffer);
  const rgb = (r: number, g: number, b: number) => 0xff000000 | (b << 16) | (g << 8) | r;
  const top = [
    rgb(190, 190, 190),
    rgb(190, 190, 0),
    rgb(0, 190, 190),
    rgb(0, 190, 0),
    rgb(190, 0, 190),
    rgb(190, 0, 0),
    rgb(0, 0, 190),
  ];
  const bottom = [rgb(0, 33, 76), rgb(238, 238, 238), rgb(50, 0, 106), rgb(10, 10, 10)];
  for (let y = 0; y < NES_HEIGHT; y++) {
    for (let x = 0; x < NES_WIDTH; x++) {
      bars32[y * NES_WIDTH + x] =
        y < NES_HEIGHT * 0.72
          ? top[Math.min(6, (x / (NES_WIDTH / 7)) | 0)]
          : bottom[Math.min(3, (x / (NES_WIDTH / 4)) | 0)];
    }
  }
}

// ------------------------------------------------------------ attract mode

let galleryEnteredAt = performance.now();
let powerOffStatic = 0;

let attractEmu: Emulator | null = null;
let attract: { idx: number; until: number } | null = null;
let attractLoading = false;
let attractStatic = 0;

// Idle on the gallery long enough and the TV starts playing the library to
// itself, cycling every 20s with a burst of static between "channels".
async function nextAttractChannel(): Promise<void> {
  attractLoading = true;
  try {
    const idx = attract
      ? (attract.idx + 1) % library.length
      : Math.floor(Math.random() * library.length);
    const bytes = await romBytes(library[idx]);
    attractEmu ??= new Emulator(44100, () => {});
    attractEmu.loadROM(bytes);
    attract = { idx, until: performance.now() + 20_000 };
    attractStatic = 18;
    showChannel(idx + 1);
  } catch {
    attract = null;
  } finally {
    attractLoading = false;
  }
}

function stopAttract(): void {
  attract = null;
  attractStatic = 0;
  stage.classList.remove("attract");
}

let channelOsdTimer = 0;

function showChannel(n: number | string): void {
  const osd = $("#ch-osd");
  osd.textContent = typeof n === "number" ? `CH ${String(n).padStart(2, "0")}` : String(n);
  osd.hidden = false;
  clearTimeout(channelOsdTimer);
  channelOsdTimer = window.setTimeout(() => (osd.hidden = true), 1600);
}

// ---------------------------------------------------------- ambient light

let ambientTick = 0;
let ambR = -99;
let ambG = 0;
let ambB = 0;

// Average the frame and hand it to CSS so the wall behind the TV picks up
// the picture. Every 30th frame, sparsely sampled, and only written when it
// actually moved: this drives a transition, so writing per frame would
// repaint the whole backdrop 60x/s.
function updateAmbient(rgba: Uint8Array): void {
  if (++ambientTick % 30 !== 0) return;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < rgba.length; i += 692) {
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    n++;
  }
  const k = 1.5 / n;
  r = Math.min(255, r * k) | 0;
  g = Math.min(255, g * k) | 0;
  b = Math.min(255, b * k) | 0;
  if (Math.abs(r - ambR) + Math.abs(g - ambG) + Math.abs(b - ambB) < 12) return;
  ambR = r;
  ambG = g;
  ambB = b;
  stage.style.setProperty("--ambient", `${r}, ${g}, ${b}`);
}

function updateLed(): void {
  let state = "off";
  if (view === "playing" && game) state = "on";
  if (!hostCode.hidden && !netplay.active) state = "blink";
  tvFrame.dataset.led = state;
  $("#console-prop").classList.toggle("on", state !== "off");
}

// -------------------------------------------------------- power animation

let powerFrom = 1;
let powerTarget = 1;
let powerStart = 0;
let powerDur = 1;
let powerResolve: (() => void) | null = null;

// Drives the CRT power ramp in the shader. Returns a promise so a view
// transition can await the tube going dark before swapping what's behind it.
function animatePower(target: number, ms: number): Promise<void> {
  powerFrom = renderer.power;
  powerTarget = target;
  powerStart = performance.now();
  powerDur = ms;
  return new Promise((res) => (powerResolve = res));
}

function stepPower(now: number): void {
  const t = Math.min(1, (now - powerStart) / powerDur);
  renderer.power = powerFrom + (powerTarget - powerFrom) * t;
  if (t >= 1 && powerResolve) {
    powerResolve();
    powerResolve = null;
  }
}

// ------------------------------------------------------ library & carousel

// A bundled manifest entry, or a ROM the user dropped in (`mine`, keyed by
// its SHA-256 `hash` so saves survive a re-import under a different name).
type LibraryEntry = RomEntry & { mine?: boolean; hash?: string };

let library: LibraryEntry[] = [];
let selected = 0;

const carts: HTMLElement[] = [];
const romCache = new Map<string, Uint8Array>();

function renderCarousel(): void {
  carousel.innerHTML = "";
  carts.length = 0;
  if (selected >= library.length) selected = 0;
  library.forEach((entry, i) => {
    const el = document.createElement("div");
    el.className = entry.mine ? "cart mine" : "cart";
    el.innerHTML = `
      <div class="cart-body">
        ${entry.mine ? '<span class="cart-mine" title="Your ROM"></span>' : ""}
        <div class="cart-label">
          <div class="label-placeholder">${entry.title}</div>
          <img alt="${entry.title}" draggable="false" hidden />
        </div>
        <div class="cart-title">${entry.title}</div>
      </div>`;
    // A drag across the carousel ends in a click on whatever cart is under
    // the finger; `dragged` swallows it.
    el.addEventListener("click", () => {
      if (dragged) return;
      if (i === selected) void launchSelected();
      else selectCart(i);
    });
    carousel.appendChild(el);
    carts.push(el);
    const cached = cachedLabel(entry);
    if (cached) applyLabel(el, cached);
    else el.classList.add("generating");
  });
  layoutCarousel();
}

function applyLabel(cart: HTMLElement, dataUrl: string): void {
  const img = cart.querySelector("img") as HTMLImageElement;
  img.src = dataUrl;
  img.hidden = false;
  cart.classList.remove("generating");
  cart.classList.add("label-in");
  (cart.querySelector(".label-placeholder") as HTMLElement).hidden = true;
}

// 3D shelf: the selected cart faces front, neighbours angle away and sink
// back, anything past +/-2 fades out entirely.
function layoutCarousel(): void {
  carts.forEach((el, i) => {
    const d = i - selected;
    const yaw = d === 0 ? 0 : d < 0 ? 32 : -32;
    el.style.transform =
      `translateY(-50%) translateX(${d * 108}%) rotateY(${yaw}deg) ` +
      `scale(${d === 0 ? 1 : 0.7}) translateZ(${d === 0 ? 30 : -80}px)`;
    el.style.opacity = String(Math.abs(d) > 2 ? 0 : d === 0 ? 1 : 0.75);
    el.style.zIndex = String(100 - Math.abs(d));
    el.style.filter = d === 0 ? "none" : "brightness(0.75)";
    el.classList.toggle("selected", d === 0);
  });
  const entry = library[selected];
  cartMeta.textContent = entry ? (entry.year ? `${entry.author} · ${entry.year}` : entry.author) : "";
  syncRemoveButton();
}

function syncRemoveButton(): void {
  const btn = $("#btn-remove");
  if (btn) btn.hidden = !library[selected]?.mine;
}

function selectCart(i: number): void {
  if (i < 0 || i >= library.length || i === selected) return;
  selected = i;
  sfx.move();
  layoutCarousel();
}

// Saves for an added ROM key off its hash, so renaming the file keeps them.
function saveKeyFor(entry: LibraryEntry): string {
  return entry.mine && entry.hash ? entry.hash : entry.title;
}

async function romBytes(entry: LibraryEntry): Promise<Uint8Array> {
  let bytes = romCache.get(entry.file);
  if (!bytes) {
    if (entry.mine && entry.hash) {
      const rec = await getUserRom(entry.hash);
      if (!rec) throw new Error("ROM missing from storage");
      bytes = rec.bytes;
    } else {
      bytes = await fetchRom(entry);
    }
    romCache.set(entry.file, bytes);
  }
  return bytes;
}

async function launchSelected(): Promise<void> {
  const entry = library[selected];
  if (!entry) return;
  try {
    await launchGame(entry.title, await romBytes(entry), {
      channel: selected + 1,
      key: saveKeyFor(entry),
      mine: entry.mine,
    });
  } catch (e) {
    sfx.error();
    flash(`LOAD FAILED: ${e instanceof Error ? e.message : e}`);
  }
}

let generatingLabels = false;

// Cart art is a screenshot of each game's own title screen, produced by
// running it headless. Done one at a time in the background, and parked
// entirely while a game is actually being played.
async function generateMissingLabels(): Promise<void> {
  if (generatingLabels) return;
  generatingLabels = true;
  try {
    for (let i = 0; i < library.length; i++) {
      const entry = library[i];
      if (cachedLabel(entry)) continue;
      while (view === "playing") await new Promise((r) => setTimeout(r, 300));
      try {
        applyLabel(carts[i], await generateLabel(entry, await romBytes(entry)));
      } catch {
        carts[i]?.classList.remove("generating");
      }
    }
  } finally {
    generatingLabels = false;
  }
}

// ------------------------------------------------------------ game session

function syncViews(): void {
  viewGallery.hidden = view !== "gallery";
  hud.hidden = view !== "playing";
  stage.classList.toggle("playing", view === "playing");
  // Save/load are per-machine state; netplay owns the timeline instead.
  const locked = !game || netplay.active;
  btnSave.disabled = locked;
  btnLoad.disabled = locked;
  $<HTMLButtonElement>("#btn-shot").disabled = !game;
  $<HTMLButtonElement>("#btn-label").disabled = !game;
  updateLed();
}

interface LaunchOpts {
  channel?: number | string;
  key?: string;
  mine?: boolean;
  fromNet?: boolean;
}

async function launchGame(name: string, bytes: Uint8Array, opts: LaunchOpts = {}): Promise<void> {
  sfx.insert();
  noSignal.hidden = true;
  stopAttract();
  galleryEnteredAt = performance.now();

  const key = opts.key ?? name;
  const hasSave = !opts.fromNet && localStorage.getItem(`channel3-state:${key}`) !== null;

  lastAutosave = performance.now();
  lastFrameAt = performance.now();
  await animatePower(0, 200);
  emu.loadROM(bytes);
  game = { name, bytes, key };
  rewind.clear();
  frameCount = 0;
  paused = false;
  romName.textContent = name;
  view = "playing";
  if (!opts.fromNet && netplay.active) netplay.stop("Stopped: new game");
  syncViews();
  hud.classList.add("forced");
  setTimeout(() => hud.classList.remove("forced"), 3500);
  audio.resume();
  await animatePower(1, 850);
  showChannel(opts.channel ?? "AV");
  if (opts.mine) checkCompatibility(key);
  if (!opts.fromNet) showTouchHint();

  if (!hasSave) return;

  // There's a save for this cart: offer to pick it up, with the screenshot
  // taken when it was written so you can see where you left off.
  const preview = $("#continue-preview");
  try {
    const meta = JSON.parse(localStorage.getItem(metaKey()) ?? "null");
    if (meta?.shot) {
      $<HTMLImageElement>("#continue-shot").src = meta.shot;
      $("#continue-time").textContent =
        "SAVED " +
        new Date(meta.t)
          .toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
          .toUpperCase();
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
  } catch {
    preview.hidden = true;
  }
  paused = true;
  viewContinue.hidden = false;
  focusDialog(viewContinue);
}

// A frame with almost no distinct colours means the core never got going.
function looksBlank(rgba: Uint8Array): boolean {
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  const seen = new Set<number>();
  for (let i = 0; i < px.length; i += 137) {
    seen.add(px[i]);
    if (seen.size > 2) return false;
  }
  return true;
}

// jsnes doesn't cover every mapper. Rather than leave someone staring at a
// black screen, say so — but only once the game has had time to boot, and
// never while the continue prompt is holding it paused.
function checkCompatibility(key: string): void {
  const check = () => {
    if (!game || game.key !== key) return;
    if (paused) {
      setTimeout(check, 1500);
      return;
    }
    if (looksBlank(emu.rgba)) {
      sfx.error();
      flash("⚠ THIS ROM MAY NOT BE COMPATIBLE");
    }
  };
  setTimeout(check, 2600);
}

function exitToGallery(): void {
  sfx.back();
  netplay.stop("Left the game");
  void (async () => {
    await animatePower(0, 200);
    game = null;
    paused = false;
    view = "gallery";
    hud.classList.remove("shown");
    stopAttract();
    galleryEnteredAt = performance.now();
    syncViews();
    await animatePower(1, 500);
  })();
}

function confirmExit(): void {
  if (view !== "playing") return;
  if (netplay.active) {
    $("#exit-text").textContent = "THIS WILL END THE NETPLAY SESSION.";
    $("#btn-exit-save").hidden = true;
  } else {
    $("#exit-text").textContent = "PROGRESS SINCE YOUR LAST SAVE WILL BE LOST.";
    $("#btn-exit-save").hidden = false;
  }
  paused = true;
  viewExit.hidden = false;
  focusDialog(viewExit);
  sfx.select();
}

function closeExit(resume: boolean): void {
  viewExit.hidden = true;
  if (resume) {
    paused = false;
    sfx.back();
  }
}

// ---------------------------------------------------------------- autosave

let lastAutosave = 0;

function maybeAutosave(now: number): void {
  if (!settings.autosave || !game || netplay.active || view !== "playing" || paused) return;
  if (now - lastAutosave < 30_000) return;
  lastAutosave = now;
  try {
    writeState();
    flashAutosaveOsd();
  } catch {
    // quota — the periodic save is best-effort, the manual one reports
  }
}

let autosaveOsdTimer = 0;

function flashAutosaveOsd(): void {
  const osd = $("#autosave-osd");
  osd.hidden = true;
  void osd.offsetWidth; // restart the CSS animation
  osd.hidden = false;
  clearTimeout(autosaveOsdTimer);
  autosaveOsdTimer = window.setTimeout(() => (osd.hidden = true), 1700);
}

// Closing the tab is the most common way to stop playing, so treat it as an
// exit and take one last save.
window.addEventListener("pagehide", () => {
  if (settings.autosave && game && !netplay.active && view === "playing") {
    try {
      writeState();
    } catch {
      // nothing useful to do while the page is going away
    }
  }
});

// ---------------------------------------------------------------- netplay

const netplay = new Netplay({
  onStatus: (text) => (netStatus.textContent = text.toUpperCase()),
  onPeerConnected: () => {
    // Host ships the cart the moment a guest attaches.
    if (game) netplay.sendRom(game.name, game.bytes);
  },
  onRom: (name, bytes) => {
    void (async () => {
      try {
        await launchGame(name, bytes, { fromNet: true });
        netplay.sendReady();
      } catch {
        netplay.stop("Bad ROM from host");
      }
    })();
  },
  onStart: () => {
    // Both sides reload from byte zero so the deterministic cores line up.
    if (game) emu.loadROM(game.bytes);
    rewind.clear();
    paused = false;
    frameCount = 0;
    viewVs.hidden = true;
    viewContinue.hidden = true;
    viewExit.hidden = true;
    sfx.connect();
    flash(netplay.role === "host" ? "PLAYER 2 JOINED!" : "CONNECTED AS P2");
    syncViews();
  },
  onStop: (reason) => {
    netStatus.textContent = reason.toUpperCase();
    hostCode.hidden = true;
    sfx.error();
    flash(reason.toUpperCase());
    syncViews();
  },
});

function openVs(): void {
  sfx.select();
  const name = game?.name ?? library[selected]?.title;
  vsGame.textContent = name ? `GAME: ${name}` : "";
  btnHost.disabled = !name;
  viewVs.hidden = false;
}

btnHost.addEventListener("click", async () => {
  btnHost.disabled = true;
  try {
    // Hosting from the gallery: boot the selected cart first, so there's
    // something to hand the guest.
    if (!game) {
      const entry = library[selected];
      if (!entry) return;
      await launchGame(entry.title, await romBytes(entry));
      viewContinue.hidden = true;
      paused = false;
      viewVs.hidden = false;
    }
    roomCode.textContent = await netplay.host();
    hostCode.hidden = false;
    updateLed();
  } catch {
    // netplay reports its own failures through onStop
  } finally {
    btnHost.disabled = false;
  }
});

$("#btn-join").addEventListener("click", () => {
  const code = $<HTMLInputElement>("#join-code").value;
  if (!code.trim()) return;
  audio.resume();
  sfx.select();
  netplay.join(code);
});

// ------------------------------------------------------------ save states

function stateKey(): string {
  return `channel3-state:${game?.key ?? ""}`;
}

function metaKey(): string {
  return `channel3-meta:${game?.key ?? ""}`;
}

// Thumbnail for the continue prompt. Overscan is cropped the same 8px the
// renderer crops, so the preview matches what was on screen.
function thumbnail(): string {
  const out = document.createElement("canvas");
  out.width = 160;
  out.height = 140;
  const ctx = out.getContext("2d") as CanvasRenderingContext2D;
  const full = document.createElement("canvas");
  full.width = NES_WIDTH;
  full.height = NES_HEIGHT - 16;
  const img = new ImageData(NES_WIDTH, NES_HEIGHT);
  img.data.set(emu.rgba);
  (full.getContext("2d") as CanvasRenderingContext2D).putImageData(img, 0, -8);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(full, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.7);
}

function writeState(): void {
  localStorage.setItem(stateKey(), emu.serialize());
  try {
    localStorage.setItem(metaKey(), JSON.stringify({ t: Date.now(), shot: thumbnail() }));
  } catch {
    // the state itself landed; losing the thumbnail is survivable
  }
}

function saveState(): void {
  if (!game || netplay.active) return;
  try {
    writeState();
    sfx.select();
    flash("STATE SAVED");
  } catch {
    sfx.error();
    flash("SAVE FAILED (TOO LARGE)");
  }
}

function loadState(): void {
  if (!game || netplay.active) return;
  const json = localStorage.getItem(stateKey());
  if (!json) {
    sfx.error();
    flash("NO SAVED STATE");
    return;
  }
  emu.deserialize(json);
  rewind.clear();
  sfx.select();
  flash("STATE LOADED");
}

// ------------------------------------------------------------------ badge

function setBadge(text: string | null): void {
  badge.hidden = text === null;
  badge.textContent = text ?? "";
}

let badgeTimer = 0;

// Transient message, then back to whatever the persistent state is.
function flash(text: string): void {
  setBadge(text);
  clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(() => {
    setBadge(
      netplay.active
        ? `NETPLAY · ${netplay.role === "host" ? "P1" : "P2"}`
        : paused
          ? "PAUSED"
          : null,
    );
  }, 1600);
}

input.onHotkey = (key) => {
  if (view !== "playing") return;
  if (key === "save") saveState();
  else if (key === "load") loadState();
  else if (key === "pause" && game && !netplay.active) {
    paused = !paused;
    setBadge(paused ? "PAUSED" : null);
  }
};

// ------------------------------------------------------- dialogs & focus

// The three confirm dialogs, in priority order.
function activeDialog(): HTMLElement | null {
  if (!viewExit.hidden) return viewExit;
  if (!viewRemove.hidden) return viewRemove;
  if (!viewContinue.hidden) return viewContinue;
  return null;
}

function anyOverlayOpen(): boolean {
  return !viewSettings.hidden || !viewVs.hidden || activeDialog() !== null;
}

function dialogButtons(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".nes-btn")).filter(
    (b) => !b.hidden && !b.disabled && b.offsetParent !== null && !b.classList.contains("close-x"),
  );
}

function moveDialogFocus(root: HTMLElement, dir: number): void {
  const btns = dialogButtons(root);
  if (!btns.length) return;
  const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
  const next = cur < 0 ? (dir > 0 ? 0 : btns.length - 1) : (cur + dir + btns.length) % btns.length;
  btns[next].focus();
  sfx.move();
}

function activateDialog(root: HTMLElement): void {
  const el = document.activeElement;
  if (el instanceof HTMLButtonElement && root.contains(el)) el.click();
  else dialogButtons(root)[0]?.click();
}

function cancelDialog(root: HTMLElement): void {
  if (root === viewExit) closeExit(true);
  else if (root === viewRemove) {
    viewRemove.hidden = true;
    pendingRemove = null;
    sfx.back();
  }
}

function focusDialog(root: HTMLElement): void {
  const btns = dialogButtons(root);
  (btns.find((b) => b.classList.contains("is-primary")) ?? btns[0])?.focus();
}

// -------------------------------------------------------------- keyboard

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) {
    if (e.code === "Enter" && e.target.id === "join-code") $("#btn-join").click();
    return;
  }
  if (e.code === "KeyF" && !e.repeat) {
    toggleFullscreen();
    return;
  }
  const dialog = activeDialog();
  if (dialog) {
    if (e.code === "ArrowLeft" || e.code === "ArrowUp") moveDialogFocus(dialog, -1);
    else if (e.code === "ArrowRight" || e.code === "ArrowDown") moveDialogFocus(dialog, 1);
    else if (e.code === "Enter" || e.code === "Space") activateDialog(dialog);
    else if (e.code === "Escape") cancelDialog(dialog);
    else return;
    e.preventDefault();
    return;
  }
  if (!viewSettings.hidden || !viewVs.hidden) {
    if (e.code === "Escape") {
      viewSettings.hidden = true;
      viewVs.hidden = true;
      sfx.back();
    }
    return;
  }
  if (view === "gallery") {
    if (e.code === "ArrowLeft") selectCart(selected - 1);
    else if (e.code === "ArrowRight") selectCart(selected + 1);
    else if (e.code === "Enter" && !e.repeat) void launchSelected();
    else if (e.code === "KeyV" && !e.repeat) openVs();
  } else if (e.code === "Escape") {
    confirmExit();
  }
});

// Flipping channels with the wheel, like a tuner dial.
window.addEventListener(
  "wheel",
  (e) => {
    if (view !== "gallery" || !viewVs.hidden || !viewSettings.hidden) return;
    selectCart(selected + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1));
  },
  { passive: true },
);

window.addEventListener("contextmenu", (e) => e.preventDefault());

// --------------------------------------------------------- carousel drag

let dragged = false;
let dragging = false;
let dragAnchorX = 0;
let dragStartX = 0;

carousel.addEventListener("pointerdown", (e) => {
  if (view !== "gallery" || !viewVs.hidden || !viewSettings.hidden || !viewRemove.hidden) return;
  dragging = true;
  dragged = false;
  dragAnchorX = e.clientX;
  dragStartX = e.clientX;
  try {
    carousel.setPointerCapture(e.pointerId);
  } catch {
    // capture is a nicety; the drag still tracks without it
  }
});

carousel.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  if (Math.abs(e.clientX - dragStartX) > 8) dragged = true;
  const dx = e.clientX - dragAnchorX;
  if (Math.abs(dx) < 64) return;
  selectCart(selected + (dx < 0 ? 1 : -1));
  dragAnchorX = e.clientX;
  dragged = true;
});

const endDrag = (e: PointerEvent) => {
  if (!dragging) return;
  dragging = false;
  if (Math.abs(e.clientX - dragStartX) > 8) dragged = true;
  try {
    carousel.releasePointerCapture(e.pointerId);
  } catch {
    // already released
  }
  // Clear after the click event that follows this pointerup.
  setTimeout(() => (dragged = false), 0);
};

carousel.addEventListener("pointerup", endDrag);
carousel.addEventListener("pointercancel", endDrag);

// ------------------------------------------------------------ fullscreen

// Orientation lock is a mobile-only API and isn't in the DOM lib types.
interface OrientationLock {
  lock?: (o: string) => Promise<void>;
  unlock?: () => void;
}

function toggleFullscreen(): void {
  const orientation = screen.orientation as unknown as OrientationLock | undefined;
  if (document.fullscreenElement) {
    try {
      orientation?.unlock?.();
    } catch {
      // orientation lock is unsupported on desktop
    }
    void document.exitFullscreen();
  } else {
    stage
      .requestFullscreen()
      .then(() => {
        // Only pin landscape on something that's actually a handheld.
        if (orientation?.lock && (navigator.maxTouchPoints ?? 0) > 0) {
          orientation.lock("landscape").catch(() => {});
        }
      })
      .catch(() => {});
  }
}

$("#btn-fullscreen").addEventListener("click", toggleFullscreen);

$("#btn-power").addEventListener("click", () => {
  if (view === "playing") {
    confirmExit();
  } else {
    // Already in the gallery: just thump the tube.
    powerOffStatic = 12;
    renderer.vhs = 1.4;
    sfx.back();
  }
});

// ------------------------------------------------- controller prop & pad

// The little pad in the scene lights its buttons with the live input.
const PAD_FACE: [HTMLElement | null, number][] = [
  [document.querySelector(".pf-a"), BTN.A],
  [document.querySelector(".pf-b"), BTN.B],
  [document.querySelector(".pf-select"), BTN.SELECT],
  [document.querySelector(".pf-start"), BTN.START],
  [document.querySelector(".pf-up"), BTN.UP],
  [document.querySelector(".pf-down"), BTN.DOWN],
  [document.querySelector(".pf-left"), BTN.LEFT],
  [document.querySelector(".pf-right"), BTN.RIGHT],
];

let padFaceBits = -1;

function updatePadFace(bits: number): void {
  if (bits === padFaceBits) return;
  padFaceBits = bits;
  for (const [el, bit] of PAD_FACE) el?.classList.toggle("on", (bits & bit) !== 0);
}

let lastPointerMove = performance.now();

window.addEventListener("pointermove", () => {
  lastPointerMove = performance.now();
  stage.classList.remove("cursor-hidden");
});

function gamepadConnected(): boolean {
  const pads = navigator.getGamepads?.();
  return !!pads && Array.from(pads).some((p) => p && p.connected);
}

function toastPad(text: string): void {
  $("#toast-gamepad-text").textContent = text;
  toastGamepad.hidden = false;
  setTimeout(() => (toastGamepad.hidden = true), 3200);
}

window.addEventListener("gamepadconnected", (e) => {
  sfx.connect();
  toastPad(`CONNECTED: ${e.gamepad.id.slice(0, 44).toUpperCase()}`);
});

window.addEventListener("gamepaddisconnected", () => {
  sfx.error();
  toastPad("GAMEPAD DISCONNECTED");
});

// -------------------------------------------------------------- main loop

let lastTickAt = performance.now();
let accum = 0;
let lastFrameAt = performance.now();
let idleParity = 0;
let rewindAccum = 0;
let dialogPadPrev = 0;
let galleryPadPrev = 0;

function tick(now: number): void {
  accum += now - lastTickAt;
  lastTickAt = now;
  // A long stall (tab restore, GC pause) must not turn into a burst of
  // catch-up frames — drop the debt and carry on.
  if (accum > 100) accum = FRAME_MS;

  stepPower(now);
  maybeAutosave(now);
  syncTouchControls();

  // A dialog owns the gamepad while it's up, on button edges only.
  const dialog = activeDialog();
  if (dialog) {
    const pad = input.pollGamepad();
    const pressed = pad & ~dialogPadPrev;
    dialogPadPrev = pad;
    if (pressed & (BTN.LEFT | BTN.UP)) moveDialogFocus(dialog, -1);
    else if (pressed & (BTN.RIGHT | BTN.DOWN)) moveDialogFocus(dialog, 1);
    else if (pressed & (BTN.A | BTN.START)) activateDialog(dialog);
    else if (pressed & BTN.B) cancelDialog(dialog);
  } else {
    dialogPadPrev = 0;
  }

  if (view === "playing" && !paused && now - lastPointerMove > 2000) {
    stage.classList.add("cursor-hidden");
  }

  const rewinding =
    view === "playing" && input.rewindHeld && !netplay.active && game !== null;
  renderer.vhs += ((rewinding ? 1 : 0) - renderer.vhs) * 0.2;
  if (renderer.vhs < 0.01) renderer.vhs = 0;
  rewOverlay.hidden = !rewinding;

  if (ambientTick % 30 === 0) {
    const connected = gamepadConnected();
    padFloor.classList.toggle("connected", connected);
    padFloor.title = connected ? "Gamepad connected" : "No gamepad";
  }

  updatePadFace(input.poll());

  // ---- gallery: static, attract mode, no game running
  if (view === "gallery" || !game) {
    // Nothing here needs 60Hz. Halve it unless the attract emulator or the
    // power-off burst actually wants frames.
    if ((++idleParity & 1) === 1 && !attract && powerOffStatic === 0) {
      accum = 0;
      return;
    }
    const idleFor = now - galleryEnteredAt;
    let frame: Uint8Array;
    if (powerOffStatic > 0) {
      powerOffStatic--;
      genStatic();
      frame = staticRgba;
      noSignal.hidden = true;
    } else if (library.length > 0 && idleFor > 3000) {
      if ((!attract || now > attract.until) && !attractLoading) void nextAttractChannel();
      if (attractStatic > 0) {
        attractStatic--;
        genStatic();
        frame = staticRgba;
      } else if (attract && attractEmu) {
        attractEmu.frame();
        frame = attractEmu.rgba;
      } else {
        genStatic();
        frame = staticRgba;
      }
      noSignal.hidden = true;
    } else {
      genStatic();
      frame = staticRgba;
      // Empty library and nothing to show: say so instead of hissing forever.
      noSignal.hidden = !(library.length === 0 && idleFor > 4000);
    }
    stage.classList.toggle("attract", frame !== staticRgba);
    renderer.render(frame);
    updateAmbient(frame);

    if (view === "gallery" && viewVs.hidden && viewSettings.hidden && viewRemove.hidden) {
      const pad = input.pollGamepad();
      const pressed = pad & ~galleryPadPrev;
      galleryPadPrev = pad;
      if (pressed & BTN.LEFT) selectCart(selected - 1);
      else if (pressed & BTN.RIGHT) selectCart(selected + 1);
      else if (pressed & (BTN.A | BTN.START)) void launchSelected();
    }
    accum = 0;
    return;
  }

  // ---- paused, or an overlay is up outside netplay: hold the last frame
  if (paused || (!netplay.active && anyOverlayOpen())) {
    renderer.render(emu.rgba);
    updateAmbient(emu.rgba);
    return;
  }

  // ---- rewinding
  if (rewinding) {
    accum = 0;
    if (++rewindAccum >= REWIND_STEP) {
      rewindAccum = 0;
      const snap = rewind.pop();
      if (snap) emu.restore(snap);
    }
    audio.flush();
    renderer.render(emu.rgba);
    updateAmbient(emu.rgba);
    return;
  }

  // ---- netplay: lockstep, never step without the peer's input
  if (netplay.active) {
    let stepped = 0;
    while (accum >= FRAME_MS && stepped < MAX_CATCHUP_FRAMES) {
      if (!netplay.canStep()) {
        accum = 0;
        peerStallFrames++;
        if (peerStallFrames === 60) setBadge("WAITING FOR PEER…");
        break;
      }
      if (peerStallFrames >= 60) {
        setBadge(`NETPLAY · ${netplay.role === "host" ? "P1" : "P2"}`);
      }
      peerStallFrames = 0;
      const { p1, p2 } = netplay.step(input.poll());
      emu.setPad(1, p1);
      emu.setPad(2, p2);
      emu.frame();
      accum -= FRAME_MS;
      stepped++;
    }
    if (stepped === MAX_CATCHUP_FRAMES) accum = 0;
    audio.flush();
    if (stepped > 0) {
      renderer.render(emu.rgba);
      updateAmbient(emu.rgba);
    }
    return;
  }

  // ---- single player
  const due = now - lastFrameAt;
  if (due >= FRAME_MS) {
    // Keep the sub-frame remainder so 60.0988Hz doesn't drift against 60Hz
    // display refresh.
    lastFrameAt = now - (due % FRAME_MS);
    emu.setPad(1, input.poll());
    emu.setPad(2, input.poll2());
    emu.frame();
    if (++frameCount % REWIND_INTERVAL === 0) rewind.push(emu.snapshot());
    renderer.render(emu.rgba);
    updateAmbient(emu.rgba);
  }

  // Audio, not video, sets the real pace: if the worklet's queue is draining
  // faster than rAF delivers frames, run extra ones to refill it. Capped at
  // 2 so a slow machine degrades to a lower frame rate rather than a spiral.
  if (audio.active) {
    let extra = 0;
    while (audio.bufferedSamples < audio.targetSamples && extra++ < 2) emu.frame();
  }
  audio.flush();
}

function loop(now: number): void {
  if (!document.hidden) tick(now);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);

// rAF stops in a hidden tab, which would desync a netplay session. Nothing
// else needs to run in the background, so this is gated on netplay only.
setInterval(() => {
  if (document.hidden && netplay.active) tick(performance.now());
}, 16);

// ----------------------------------------------------------- rom import

// "Super Mario Bros. (World) [!].nes" -> "SUPER MARIO BROS." — strip the
// extension, the scene tags, and the separators the dumps use.
function prettyName(fileName: string): string {
  return (
    fileName
      .replace(/\.nes$/i, "")
      .replace(/[([][^)\]]*[)\]]/g, " ")
      .replace(/[._]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[<>&"]/g, "")
      .trim()
      .slice(0, 40) || "UNTITLED"
  );
}

function userRomToEntry(rom: UserRom): LibraryEntry {
  return {
    file: `u:${rom.hash}`,
    title: rom.title || prettyName(rom.name),
    author: rom.author || "ADDED ROM",
    year: rom.year ?? 0,
    players: 1,
    license: "user-provided",
    source: "",
    mine: true,
    hash: rom.hash,
  };
}

async function importRoms(files: File[]): Promise<void> {
  let added = 0;
  let dupes = 0;
  let failed = 0;
  let firstNew = -1;
  const fresh = new Set<string>();

  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      failed++;
      continue;
    }
    try {
      // Look the dump up by CRC32 so an added cart gets a real title and
      // author instead of a mangled file name.
      const info = (await lookupRom(bytes)) ?? undefined;
      const { rom, dup } = await addUserRom(file.name, bytes, info);
      const existing = library.findIndex((e) => e.mine && e.hash === rom.hash);
      if (existing === -1) {
        library.push(userRomToEntry(rom));
        if (firstNew < 0) firstNew = library.length - 1;
        fresh.add(rom.hash);
        added++;
      } else if (dup) {
        dupes++;
        if (firstNew < 0) firstNew = existing;
      }
    } catch {
      failed++;
    }
  }

  renderCarousel();
  library.forEach((entry, i) => {
    if (entry.hash && fresh.has(entry.hash)) carts[i]?.classList.add("inserting");
  });
  if (firstNew >= 0) selected = firstNew;
  layoutCarousel();
  syncRemoveButton();
  void generateMissingLabels();
  void updateStorageUsage();

  const parts: string[] = [];
  if (added) parts.push(`ADDED ${added}`);
  if (dupes) parts.push(`${dupes} ALREADY IN LIBRARY`);
  if (failed) parts.push(`${failed} FAILED`);
  flash(parts.join(" · ") || "NOTHING ADDED");
  if (added) sfx.insert();
  else if (failed && !dupes) sfx.error();
  else sfx.select();
}

$("#btn-open").addEventListener("click", () => romInput.click());

romInput.addEventListener("change", () => {
  const files = Array.from(romInput.files ?? []);
  if (files.length) void importRoms(files);
  romInput.value = "";
});

stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  overlay.classList.add("dragover");
});

stage.addEventListener("dragleave", () => overlay.classList.remove("dragover"));

stage.addEventListener("drop", (e) => {
  e.preventDefault();
  overlay.classList.remove("dragover");
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => /\.nes$/i.test(f.name));
  if (files.length) void importRoms(files);
});

// ------------------------------------------------------------- hud wiring

$("#btn-play").addEventListener("click", () => void launchSelected());
$("#btn-exit-cancel").addEventListener("click", () => closeExit(true));

$("#btn-exit-save").addEventListener("click", () => {
  try {
    writeState();
  } catch {
    // leaving anyway; a failed save shouldn't trap the user in the dialog
  }
  closeExit(false);
  exitToGallery();
});

$("#btn-exit-nosave").addEventListener("click", () => {
  closeExit(false);
  exitToGallery();
});

$("#btn-continue-load").addEventListener("click", () => {
  viewContinue.hidden = true;
  const json = localStorage.getItem(stateKey());
  if (json) {
    emu.deserialize(json);
    rewind.clear();
  }
  paused = false;
  sfx.select();
});

$("#btn-continue-new").addEventListener("click", () => {
  viewContinue.hidden = true;
  paused = false;
  sfx.select();
});

const autosaveToggle = $<HTMLInputElement>("#autosave-on");
autosaveToggle.checked = settings.autosave;
autosaveToggle.addEventListener("change", () => {
  settings.autosave = autosaveToggle.checked;
  saveSettings();
});

$("#btn-shot").addEventListener("click", () => {
  if (!game) return;
  // 3x integer scale, overscan cropped like the renderer does.
  const out = document.createElement("canvas");
  out.width = NES_WIDTH * 3;
  out.height = (NES_HEIGHT - 16) * 3;
  const full = document.createElement("canvas");
  full.width = NES_WIDTH;
  full.height = NES_HEIGHT - 16;
  const img = new ImageData(NES_WIDTH, NES_HEIGHT);
  img.data.set(emu.rgba);
  (full.getContext("2d") as CanvasRenderingContext2D).putImageData(img, 0, -8);
  const ctx = out.getContext("2d") as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(full, 0, 0, out.width, out.height);
  const a = document.createElement("a");
  a.href = out.toDataURL("image/png");
  a.download = `channel3-${game.name.replace(/\.nes$/i, "")}-${Date.now()}.png`;
  a.click();
  sfx.select();
  flash("SCREENSHOT SAVED");
});

// Pin the current frame as this cart's label art, overriding the one the
// generator picked.
$("#btn-label").addEventListener("click", () => {
  if (!game) return;
  const i = library.findIndex((e) => saveKeyFor(e) === game!.key);
  if (i < 0) {
    sfx.error();
    flash("NO CART FOR THIS ROM");
    return;
  }
  applyLabel(carts[i], storeLabel(library[i], emu.rgba));
  sfx.select();
  flash("CART LABEL SET");
});

// ---------------------------------------------------------- settings: av

const volumeHud = $<HTMLInputElement>("#volume");
const volumeCfg = $<HTMLInputElement>("#volume-cfg");

// Two sliders, one value: the HUD one and the settings one mirror each other.
function setVolume(v: number): void {
  settings.volume = v;
  audio.setVolume(v);
  setSfxVolume(v);
  const pct = String(Math.round(v * 100));
  if (volumeHud.value !== pct) volumeHud.value = pct;
  if (volumeCfg.value !== pct) volumeCfg.value = pct;
}

setVolume(settings.volume);

const onVolumeInput = (el: HTMLInputElement) => () => {
  setVolume(Number(el.value) / 100);
  saveSettings();
};

volumeHud.addEventListener("input", onVolumeInput(volumeHud));
volumeCfg.addEventListener("input", onVolumeInput(volumeCfg));

const themeSelect = $<HTMLSelectElement>("#theme-select");

// The default lives in CSS; only non-default variants get a data attribute.
function applyTheme(v: string): void {
  if (v === "famicom") delete document.body.dataset.theme;
  else document.body.dataset.theme = v;
}

themeSelect.value = settings.theme;
applyTheme(settings.theme);
themeSelect.addEventListener("change", () => {
  settings.theme = themeSelect.value;
  applyTheme(settings.theme);
  saveSettings();
  sfx.select();
});

const wallSelect = $<HTMLSelectElement>("#wall-select");

function applyWall(v: string): void {
  if (v === "diamonds") delete document.body.dataset.wall;
  else document.body.dataset.wall = v;
}

wallSelect.value = settings.wall;
applyWall(settings.wall);
wallSelect.addEventListener("change", () => {
  settings.wall = wallSelect.value;
  applyWall(settings.wall);
  saveSettings();
  sfx.select();
});

const CRT_PRESETS: Record<string, typeof crt> = {
  off: { enabled: false, curvature: 0, scanline: 0, mask: 0, glow: 0, aberration: 0, vignette: 0 },
  scanlines: {
    enabled: true, curvature: 0, scanline: 0.55, mask: 0, glow: 0, aberration: 0, vignette: 0,
  },
  tube: {
    enabled: true, curvature: 0.28, scanline: 0.2, mask: 0, glow: 0.25, aberration: 0, vignette: 0.3,
  },
  rgb: {
    enabled: true, curvature: 0.05, scanline: 0.3, mask: 0.5, glow: 0.15, aberration: 0, vignette: 0.1,
  },
  vhs: {
    enabled: true, curvature: 0.18, scanline: 0.2, mask: 0, glow: 0.5, aberration: 0.35, vignette: 0.3,
  },
};

const CRT_SLIDERS: [string, keyof typeof crt][] = [
  ["#crt-curvature", "curvature"],
  ["#crt-scanline", "scanline"],
  ["#crt-mask", "mask"],
  ["#crt-glow", "glow"],
  ["#crt-aberration", "aberration"],
  ["#crt-vignette", "vignette"],
];

$("#crt-preset").addEventListener("change", (e) => {
  const value = (e.target as HTMLSelectElement).value;
  const sliders = $("#crt-sliders");
  if (value === "custom") {
    sliders.hidden = false;
    crt.enabled = true;
    sfx.select();
    return;
  }
  sliders.hidden = true;
  const preset = CRT_PRESETS[value];
  if (!preset) return;
  Object.assign(crt, preset);
  for (const [sel, key] of CRT_SLIDERS) {
    $<HTMLInputElement>(sel).value = String(Math.round((crt[key] as number) * 100));
  }
  sfx.select();
});

const filterSelect = $<HTMLSelectElement>("#filter-select");
filterSelect.value = settings.filter;
renderer.filter = settings.filter;
filterSelect.addEventListener("change", () => {
  settings.filter = filterSelect.value as Settings["filter"];
  renderer.filter = settings.filter;
  saveSettings();
  sfx.select();
});

const tvSelect = $<HTMLSelectElement>("#tv-select");

function applyTv(v: string): void {
  if (v === "full") delete document.body.dataset.tv;
  else document.body.dataset.tv = v;
}

const screenWrap = $("#screen-wrap");
const coarsePointer = matchMedia("(pointer: coarse)").matches;

// Pick the largest integer scale whose 224-line picture still fits the box,
// so the NES grid lands on whole device pixels. Phones cap at 2x.
function fitScreen(): void {
  const h = screenWrap.getBoundingClientRect().height;
  const dpr = window.devicePixelRatio || 1;
  const k = Math.max(1, Math.min(coarsePointer ? 2 : 4, Math.ceil((h * dpr) / 224 - 0.02)));
  renderer.setScale(k);
}

window.addEventListener("resize", fitScreen);
document.addEventListener("fullscreenchange", fitScreen);

tvSelect.value = settings.tv;
applyTv(settings.tv);
fitScreen();
tvSelect.addEventListener("change", () => {
  settings.tv = tvSelect.value;
  applyTv(settings.tv);
  fitScreen();
  saveSettings();
  sfx.select();
});

// ------------------------------------------------------- settings: binds

const BINDS_KEY = "channel3-binds";

const BIND_ROWS: { a: Action; label: string }[] = [
  { a: "up", label: "UP" },
  { a: "down", label: "DOWN" },
  { a: "left", label: "LEFT" },
  { a: "right", label: "RIGHT" },
  { a: "a", label: "A" },
  { a: "b", label: "B" },
  { a: "select", label: "SELECT" },
  { a: "start", label: "START" },
];

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "ENTER",
  Space: "SPACE",
  ShiftLeft: "LSHIFT",
  ShiftRight: "RSHIFT",
  ControlLeft: "LCTRL",
  ControlRight: "RCTRL",
  Backspace: "BKSP",
  Tab: "TAB",
};

function keyLabel(code: string): string {
  if (!code) return "—";
  return KEY_LABELS[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "NUM");
}

const keyList = (codes: string[]) => codes.map(keyLabel).join("/") || "—";
const padList = (idx: number[]) => idx.map((i) => `B${i}`).join("/") || "—";

// Stored binds are user data and may predate an action being added, so fill
// every gap from the defaults rather than trusting the blob.
function normalizeBinds(raw: unknown): [Binds, Binds] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const one = (stored: Partial<Binds> | undefined, player: 0 | 1): Binds => {
    const src = stored ?? ({} as Partial<Binds>);
    const fallback = defaultBinds(player);
    const key = {} as Binds["key"];
    const pad = {} as Binds["pad"];
    for (const action of ACTIONS) {
      const k = src.key?.[action];
      const p = src.pad?.[action];
      key[action] = Array.isArray(k) ? k : fallback.key[action];
      pad[action] = Array.isArray(p) ? p : fallback.pad[action];
    }
    return { key, pad };
  };
  return [one(raw[0], 0), one(raw[1], 1)];
}

function loadBinds(): void {
  try {
    const binds = normalizeBinds(JSON.parse(localStorage.getItem(BINDS_KEY) ?? "null"));
    if (binds) input.setBinds(binds);
  } catch {
    // fall back to defaults
  }
}

function persistBinds(): void {
  localStorage.setItem(BINDS_KEY, JSON.stringify(input.getBinds()));
}

// A key can only mean one thing: strip it from every other slot first.
function releaseKey(code: string, player: 0 | 1, action: Action): void {
  const binds = input.getBinds();
  for (const p of [0, 1] as const) {
    for (const a of ACTIONS) {
      if (p === player && a === action) continue;
      binds[p].key[a] = binds[p].key[a].filter((c) => c !== code);
    }
  }
}

// Pad buttons only clash within their own player — both pads have a B0.
function releasePadButton(index: number, player: 0 | 1, action: Action): void {
  const binds = input.getBinds();
  for (const a of ACTIONS) {
    if (a !== action) binds[player].pad[a] = binds[player].pad[a].filter((i) => i !== index);
  }
}

interface Capture {
  player: 0 | 1;
  action: Action;
  device: "key" | "pad";
  cell: HTMLElement;
}

let capture: Capture | null = null;

function cancelCapture(): void {
  if (!capture) return;
  capture.cell.classList.remove("capturing");
  capture = null;
  renderBinds();
}

function beginCapture(player: 0 | 1, action: Action, device: "key" | "pad", cell: HTMLElement): void {
  cancelCapture();
  capture = { player, action, device, cell };
  cell.classList.add("capturing");
  cell.textContent = "PRESS…";
  if (device === "pad") pollPadCapture();
}

// Gamepads don't fire events, so a capture has to spin on rAF.
function pollPadCapture(): void {
  if (!capture || capture.device !== "pad") return;
  const button = input.pressedPadButton(capture.player);
  if (button >= 0) {
    releasePadButton(button, capture.player, capture.action);
    input.setPadBind(capture.player, capture.action, button);
    persistBinds();
    sfx.select();
    cancelCapture();
    return;
  }
  requestAnimationFrame(pollPadCapture);
}

// Capture phase: swallow the key before the gameplay handlers see it.
window.addEventListener(
  "keydown",
  (e) => {
    if (!capture) return;
    if (e.code === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelCapture();
      sfx.back();
      return;
    }
    if (capture.device !== "key") return;
    e.preventDefault();
    e.stopPropagation();
    releaseKey(e.code, capture.player, capture.action);
    input.setKeyBind(capture.player, capture.action, e.code);
    persistBinds();
    sfx.select();
    cancelCapture();
  },
  true,
);

function renderBinds(): void {
  const table = $("#controls-grid");
  if (!table) return;
  const binds = input.getBinds();
  table.innerHTML =
    "<thead><tr><th></th><th>P1 KEY</th><th>P1 PAD</th><th>P2 KEY</th><th>P2 PAD</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const { a, label } of BIND_ROWS) {
    const tr = document.createElement("tr");
    const th = document.createElement("td");
    th.className = "action";
    th.textContent = label;
    tr.appendChild(th);
    const cells: [0 | 1, "key" | "pad", string][] = [
      [0, "key", keyList(binds[0].key[a])],
      [0, "pad", padList(binds[0].pad[a])],
      [1, "key", keyList(binds[1].key[a])],
      [1, "pad", padList(binds[1].pad[a])],
    ];
    for (const [player, device, text] of cells) {
      const td = document.createElement("td");
      const btn = document.createElement("button");
      btn.className = "bind";
      btn.type = "button";
      btn.textContent = text;
      btn.addEventListener("click", () => beginCapture(player, a, device, btn));
      td.appendChild(btn);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  updateHudHint();
}

// The HUD hint has to follow whatever P1 rebound their keys to.
function updateHudHint(): void {
  const keys = input.getBinds()[0].key;
  const k = (a: Action) => keyLabel(keys[a][0] ?? "");
  $("#hud-hint").textContent =
    `${k("a")}/${k("b")} = A/B · ${k("start")} START · ${k("select")} SELECT · ` +
    `K/L SAVE·LOAD · BACKSPACE REWIND · P PAUSE · F FULLSCREEN`;
}

$("#btn-binds-reset").addEventListener("click", () => {
  input.setBinds([defaultBinds(0), defaultBinds(1)]);
  persistBinds();
  renderBinds();
  sfx.select();
});

loadBinds();
renderBinds();

// ------------------------------------------------------- touch controls

const touchControls = $("#touch-controls");
const dpad = $("#touch-dpad");

function touchWanted(): boolean {
  if (settings.touch === "on") return true;
  if (settings.touch === "off") return false;
  // Auto: a touch device with no gamepad plugged in.
  return coarsePointer && (navigator.maxTouchPoints ?? 0) > 0 && !gamepadConnected();
}

let touchShown = false;

function syncTouchControls(): void {
  const show = touchWanted() && view === "playing" && !paused && !anyOverlayOpen();
  if (show === touchShown) return;
  touchShown = show;
  touchControls.hidden = !show;
  if (!show) {
    input.clearTouch();
    dpad.classList.remove("up", "down", "left", "right");
  }
}

// The d-pad is analog under the finger but always reports as a d-pad: a
// 16% dead zone in the middle, diagonals when both axes clear it.
function dpadDir(e: PointerEvent): number {
  const r = dpad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  const dead = r.width * 0.16;
  let bits = 0;
  if (dx < -dead) bits |= BTN.LEFT;
  else if (dx > dead) bits |= BTN.RIGHT;
  if (dy < -dead) bits |= BTN.UP;
  else if (dy > dead) bits |= BTN.DOWN;
  return bits;
}

function setDpad(bits: number): void {
  input.setTouchDir(bits);
  dpad.classList.toggle("up", (bits & BTN.UP) !== 0);
  dpad.classList.toggle("down", (bits & BTN.DOWN) !== 0);
  dpad.classList.toggle("left", (bits & BTN.LEFT) !== 0);
  dpad.classList.toggle("right", (bits & BTN.RIGHT) !== 0);
}

let dpadPointer = -1;

dpad.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  dpadPointer = e.pointerId;
  try {
    dpad.setPointerCapture(e.pointerId);
  } catch {
    // capture unavailable; the move handler still tracks by pointerId
  }
  setDpad(dpadDir(e));
  navigator.vibrate?.(6);
});

dpad.addEventListener("pointermove", (e) => {
  if (e.pointerId === dpadPointer) setDpad(dpadDir(e));
});

const endDpad = (e: PointerEvent) => {
  if (e.pointerId !== dpadPointer) return;
  dpadPointer = -1;
  setDpad(0);
  try {
    dpad.releasePointerCapture(e.pointerId);
  } catch {
    // already released
  }
};

dpad.addEventListener("pointerup", endDpad);
dpad.addEventListener("pointercancel", endDpad);

const TOUCH_BITS: Record<string, number> = {
  a: BTN.A,
  b: BTN.B,
  select: BTN.SELECT,
  start: BTN.START,
};

// SELECT and START are plain buttons. A and B are handled together below so
// a thumb can roll between them.
touchControls.querySelectorAll<HTMLElement>(".tbtn").forEach((btn) => {
  const bit = TOUCH_BITS[btn.dataset.btn ?? ""];
  if (!bit || btn.dataset.btn === "a" || btn.dataset.btn === "b") return;
  const down = (e: PointerEvent) => {
    e.preventDefault();
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      // non-fatal
    }
    btn.classList.add("on");
    input.setTouchButton(bit, true);
    navigator.vibrate?.(6);
  };
  const up = () => {
    btn.classList.remove("on");
    input.setTouchButton(bit, false);
  };
  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
});

// A/B share one hit area so you can roll or mash both with one thumb, and
// slide between them without lifting. Each live pointer contributes.
const abZone = $("#touch-ab");
const btnB = abZone.querySelector(".tbtn-b") as HTMLElement;
const btnA = abZone.querySelector(".tbtn-a") as HTMLElement;
const abPointers = new Map<number, { a: boolean; b: boolean }>();

const hitAb = (x: number, y: number) => {
  const test = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const pad = r.height * 0.05;
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  };
  return { b: test(btnB), a: test(btnA) };
};

const syncAb = () => {
  let b = false;
  let a = false;
  for (const hit of abPointers.values()) {
    b = b || hit.b;
    a = a || hit.a;
  }
  input.setTouchButton(TOUCH_BITS.b, b);
  input.setTouchButton(TOUCH_BITS.a, a);
  btnB.classList.toggle("on", b);
  btnA.classList.toggle("on", a);
};

abZone.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  try {
    abZone.setPointerCapture(e.pointerId);
  } catch {
    // non-fatal
  }
  abPointers.set(e.pointerId, hitAb(e.clientX, e.clientY));
  navigator.vibrate?.(6);
  syncAb();
});

abZone.addEventListener("pointermove", (e) => {
  if (!abPointers.has(e.pointerId)) return;
  abPointers.set(e.pointerId, hitAb(e.clientX, e.clientY));
  syncAb();
});

const endAb = (e: PointerEvent) => {
  if (abPointers.delete(e.pointerId)) syncAb();
};

abZone.addEventListener("pointerup", endAb);
abZone.addEventListener("pointercancel", endAb);

const touchSelect = $<HTMLSelectElement>("#touch-select");
touchSelect.value = settings.touch;
touchSelect.addEventListener("change", () => {
  settings.touch = touchSelect.value as Settings["touch"];
  saveSettings();
  syncTouchControls();
  sfx.select();
});

const touchSizeSelect = $<HTMLSelectElement>("#touch-size-select");

function applyTouchSize(v: string): void {
  if (v === "m") delete document.body.dataset.touchsize;
  else document.body.dataset.touchsize = v;
}

touchSizeSelect.value = settings.touchSize;
applyTouchSize(settings.touchSize);
touchSizeSelect.addEventListener("change", () => {
  settings.touchSize = touchSizeSelect.value;
  applyTouchSize(settings.touchSize);
  saveSettings();
  sfx.select();
});

function showTouchHint(): void {
  if (!touchWanted()) return;
  const hint = $("#touch-hint");
  hint.hidden = true;
  void hint.offsetWidth;
  hint.hidden = false;
  setTimeout(() => (hint.hidden = true), 3700);
}

// --------------------------------------------------- removing added roms

type PendingRemove = { kind: "one"; idx: number } | { kind: "all" };

let pendingRemove: PendingRemove | null = null;

function openRemove(req: PendingRemove): void {
  pendingRemove = req;
  const saveRow = $("#remove-save-row");
  if (req.kind === "one") {
    $("#remove-title").textContent = "REMOVE ROM?";
    $("#remove-text").textContent =
      `"${library[req.idx]?.title}" WILL BE DELETED FROM THIS BROWSER.`;
    $<HTMLInputElement>("#remove-save").checked = false;
    saveRow.hidden = false;
  } else {
    $("#remove-title").textContent = "DELETE EVERYTHING?";
    $("#remove-text").textContent = "ALL ROMS YOU ADDED AND THEIR SAVES WILL BE ERASED.";
    saveRow.hidden = true;
  }
  viewRemove.hidden = false;
  focusDialog(viewRemove);
  sfx.select();
}

function purgeLocal(entry: LibraryEntry, dropSaves: boolean): void {
  if (dropSaves && entry.hash) {
    localStorage.removeItem(`channel3-state:${entry.hash}`);
    localStorage.removeItem(`channel3-meta:${entry.hash}`);
  }
  localStorage.removeItem(`channel3-label:${entry.file}`);
  romCache.delete(entry.file);
}

// Let the eject animation play before the cart disappears, but don't hang
// on it if the animation never fires.
function ejectCart(idx: number): Promise<void> {
  const el = carts[idx];
  if (!el) return Promise.resolve();
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      res();
    };
    el.addEventListener("animationend", finish, { once: true });
    el.classList.add("ejecting");
    setTimeout(finish, 600);
  });
}

async function confirmRemove(): Promise<void> {
  if (!pendingRemove) return;
  const req = pendingRemove;
  pendingRemove = null;
  viewRemove.hidden = true;

  if (req.kind === "one") {
    const entry = library[req.idx];
    if (!entry?.mine || !entry.hash) return;
    const wasPlaying = game?.key === entry.hash;
    sfx.back();
    await ejectCart(req.idx);
    await deleteUserRom(entry.hash);
    purgeLocal(entry, $<HTMLInputElement>("#remove-save").checked);
    library.splice(req.idx, 1);
    if (selected >= library.length) selected = Math.max(0, library.length - 1);
    renderCarousel();
    flash("ROM REMOVED");
    if (wasPlaying) exitToGallery();
  } else {
    const mine = library.filter((e) => e.mine);
    const wasPlaying = !!game && mine.some((e) => e.hash === game!.key);
    await clearUserRoms();
    for (const entry of mine) purgeLocal(entry, true);
    library = library.filter((e) => !e.mine);
    if (selected >= library.length) selected = Math.max(0, library.length - 1);
    renderCarousel();
    flash(`REMOVED ${mine.length} ROM${mine.length === 1 ? "" : "S"}`);
    if (wasPlaying) exitToGallery();
  }
  void updateStorageUsage();
}

async function updateStorageUsage(): Promise<void> {
  const el = $("#storage-usage");
  if (el) el.textContent = await storageSummary();
}

$("#btn-remove").addEventListener("click", () => {
  if (library[selected]?.mine) openRemove({ kind: "one", idx: selected });
});

$("#btn-wipe").addEventListener("click", () => openRemove({ kind: "all" }));

$("#btn-remove-cancel").addEventListener("click", () => {
  viewRemove.hidden = true;
  pendingRemove = null;
  sfx.back();
});

$("#btn-remove-yes").addEventListener("click", () => void confirmRemove());

// ------------------------------------------------------- backup & restore

$("#btn-backup").addEventListener("click", () => {
  const blob = new Blob([exportSaves()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `channel3-saves-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  sfx.select();
  flash("SAVES BACKED UP");
});

const restoreInput = $<HTMLInputElement>("#restore-input");

$("#btn-restore").addEventListener("click", () => restoreInput.click());

restoreInput.addEventListener("change", () => {
  const file = restoreInput.files?.[0];
  restoreInput.value = "";
  if (!file) return;
  void (async () => {
    try {
      const n = importSaves(await file.text());
      sfx.connect();
      flash(`RESTORED ${n} SAVE${n === 1 ? "" : "S"}`);
    } catch (e) {
      sfx.error();
      flash(`RESTORE FAILED: ${e instanceof Error ? e.message : e}`);
    }
  })();
});

// -------------------------------------------------------------- tips & hud

const TIPS = [
  "PRESS START",
  "HOLD BACKSPACE TO REWIND TIME",
  "V = LINK UP · PLAY A FRIEND ONLINE",
  "DROP ANY .NES FILE ON THE SCREEN",
  "F = FULLSCREEN",
  "P2 ON THE SAME KEYBOARD: WASD + Q/E",
  "SCROLL THE WHEEL TO FLIP CHANNELS",
];

let tipIndex = 0;
const tips = $("#tips");

setInterval(() => {
  if (view !== "gallery") return;
  tipIndex = (tipIndex + 1) % TIPS.length;
  tips.classList.remove("blink");
  tips.textContent = TIPS[tipIndex];
  if (TIPS[tipIndex] === "PRESS START") tips.classList.add("blink");
}, 5000);

tips.classList.add("blink");

// Konami code: degauss the tube.
const KONAMI = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "KeyB", "KeyA",
];

let konamiAt = 0;

window.addEventListener("keydown", (e) => {
  konamiAt = e.code === KONAMI[konamiAt] ? konamiAt + 1 : e.code === KONAMI[0] ? 1 : 0;
  if (konamiAt !== KONAMI.length) return;
  konamiAt = 0;
  renderer.vhs = 2.6;
  sfx.connect();
  flash("DEGAUSS");
});

btnSave.addEventListener("click", saveState);
btnLoad.addEventListener("click", loadState);
$("#btn-vs").addEventListener("click", openVs);
$("#btn-vs-hud").addEventListener("click", openVs);
$("#btn-exit-hud").addEventListener("click", confirmExit);

let hudTimer = 0;

function revealHud(): void {
  hud.classList.add("shown");
  clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => hud.classList.remove("shown"), 4000);
}

function toggleHud(): void {
  if (hud.classList.contains("shown")) {
    hud.classList.remove("shown");
    clearTimeout(hudTimer);
  } else {
    revealHud();
  }
  sfx.select();
}

let lastTapAt = 0;
let tapTimer = 0;
const DOUBLE_TAP_MS = 280;

// On the screen itself: double tap/click goes fullscreen, a single tap on
// touch reveals the HUD. Mouse users get the HUD from hover, so a lone
// click there shouldn't do anything.
screenWrap.addEventListener("pointerup", (e) => {
  if (view !== "playing" || paused || anyOverlayOpen()) return;
  const t = e.target as HTMLElement;
  if (t.closest("button") || t.closest("#touch-controls") || t.closest("#hud-top")) return;
  const now = performance.now();
  if (now - lastTapAt < DOUBLE_TAP_MS) {
    clearTimeout(tapTimer);
    lastTapAt = 0;
    toggleFullscreen();
    return;
  }
  lastTapAt = now;
  const isTouch = e.pointerType === "touch";
  tapTimer = window.setTimeout(() => {
    if (isTouch) toggleHud();
  }, DOUBLE_TAP_MS);
});

$("#btn-vs-close").addEventListener("click", () => {
  viewVs.hidden = true;
  sfx.back();
});

function openSettings(): void {
  viewSettings.hidden = false;
  void updateStorageUsage();
}

$("#btn-settings").addEventListener("click", openSettings);
$("#btn-settings-hud").addEventListener("click", openSettings);

$("#btn-settings-close").addEventListener("click", () => {
  viewSettings.hidden = true;
  sfx.back();
});

// Click the backdrop (not the panel) to dismiss.
function onBackdrop(root: HTMLElement, close: () => void): void {
  root.addEventListener("pointerdown", (e) => {
    if (e.target !== root) return;
    e.preventDefault();
    close();
  });
}

onBackdrop(viewSettings, () => {
  viewSettings.hidden = true;
  sfx.back();
});

onBackdrop(viewVs, () => {
  viewVs.hidden = true;
  sfx.back();
});

onBackdrop(viewExit, () => closeExit(true));

onBackdrop(viewRemove, () => {
  viewRemove.hidden = true;
  pendingRemove = null;
  sfx.back();
});

// Live CRT sliders write straight into the renderer's params.
const crt = renderer.params;

for (const [sel, key] of CRT_SLIDERS) {
  $(sel).addEventListener("input", (e) => {
    (crt[key] as number) = Number((e.target as HTMLInputElement).value) / 100;
    crt.enabled = true;
  });
}

// ------------------------------------------------------------ audio unlock

let audioStarted = false;

// Browsers only allow an AudioContext to start inside a gesture, so the
// first interaction of any kind arms it.
function unlockAudio(): void {
  audio.resume();
  setSfxContext(audio.ctx);
  emu.setSampleRate(audio.sampleRate);
  if (audioStarted) return;
  audioStarted = true;
  void audio.init().then(() => audio.resume());
}

window.addEventListener("pointerdown", unlockAudio, { capture: true });
window.addEventListener("keydown", unlockAudio, { capture: true });
window.addEventListener("touchstart", unlockAudio, { capture: true, passive: true });

// Label art has been regenerated a few times and the project has had two
// earlier names; drop everything that's been superseded so old blobs don't
// sit in localStorage forever.
const DEAD_PREFIXES = [
  "netnes-",
  "canal3-",
  "channel3-label:",
  ...Array.from({ length: 9 }, (_, i) => `channel3-label${i + 2}:`),
];

for (const key of Object.keys(localStorage)) {
  if (DEAD_PREFIXES.some((p) => key.startsWith(p))) localStorage.removeItem(key);
}

function renderCredits(): void {
  $("#credits-list").innerHTML = library
    .filter((e) => !e.mine)
    .map(
      (e) =>
        `<li>${e.title} — ${e.author} (${e.year}) · ${e.license} · ` +
        `<a href="${e.source}" target="_blank" rel="noreferrer">source</a></li>`,
    )
    .join("");
}

// ------------------------------------------------------------------- boot

// Ask for persistent storage so the browser doesn't evict added ROMs and
// their saves under pressure.
void navigator.storage?.persist?.();

void (async () => {
  try {
    library = await loadManifest();
  } catch (e) {
    cartMeta.textContent =
      `LIBRARY UNAVAILABLE — DROP A .NES ROM (${e instanceof Error ? e.message : e})`;
  }
  try {
    library = library.concat((await listUserRoms()).map(userRomToEntry));
  } catch {
    // IndexedDB unavailable (private mode): the bundled library still works
  }
  renderCarousel();
  syncViews();
  renderCredits();
  void generateMissingLabels();
})();
