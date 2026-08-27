# recovery/ — source for rebuilding `src/main.ts`

Temporary. Delete once `src/main.ts` is rebuilt and verified.

`main-bundle-20260719.js` is a copy of `dist/assets/index-BaHMVsn1.js`, the
production build of 2026-07-19 17:09 — the last one made before the entry
point's source was lost. `.gitignore` excludes `dist/`, so it is kept here:
this is currently the only place that code exists in any form.

## Bundle layout

```
0 ──────── 183K ──────── ~190K ─── ~215K ────── 251K
   jsnes      peerjs      modules      main.ts
                          (25,959 b)   (~35 KB min.)
```

Offsets located via known strings:

| String | Origin | Offset |
| --- | --- | --- |
| `PeerJS` | peerjs | 183,697 |
| `channel3-v1-` | `src/netplay.ts` | 210,067 |
| `channel3-label11:` | `src/labels.ts` | 213,143 |
| `LIBRARY UNAVAILABLE` | `src/main.ts` | 250,992 |

Rollup emits the entry last, so **~215K → 251K** is compiled `main.ts`:
~35 KB minified, roughly 1,800–2,400 lines of original TypeScript.

## Cross-references

Three independent sources validate each other, so the rebuild is not
guesswork:

1. **This bundle** — complete logic, minified but not obfuscated.
2. **The 10 surviving modules in `src/`** — the APIs `main.ts` consumes are
   known exactly.
3. **`index.html`** — its 119 DOM ids are identical to `dist/index.html`
   (verified with `comm`, zero differences either way), confirming the
   bundle matches this HTML.

Local variable names and comments are gone with minification.

## `perf-notes-20260715.md`

An agent-written analysis of audio/video lag, from 2026-07-15 — four days
before the last build. Kept only as a structural hint for the rebuild, not
as documentation: it quotes the main loop's hidden-tab `setInterval` and the
`effFrameMs` audio pacing against `audio.bufferedSamples`, both confirmed
present in the bundle.

Its numbers are stale and its proposals were never applied — it claims
`labels.ts` runs 1,020 frames (the code runs 1,300–1,800) and a ~43 ms audio
cushion (`audio.ts` sets 4,096 samples, ~85 ms). Treat the structure as a
lead and verify every figure against the bundle.
