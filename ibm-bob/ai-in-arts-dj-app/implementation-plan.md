# Phase 4 Implementation Plan — DeckFlow Web

## Top-Level Overview

Phase 4 adds the four features that give the app its "DJ feel":
**Varispeed tempo**, **manual loops**, **in-mix cue point**, and **cue/loop markers on the waveform**.

The app is currently at Phase 3: two decks, a crossfader, per-deck EQ/filter/volume, and a live waveform. The audio engine (`deck.ts`) already has a `tempo` field in `DeckState` and comments noting varispeed arrives in P4 — the groundwork is in place, but nothing is wired up yet.

### Approach

Work layer-by-layer, bottom-up:

1. **State & audio layer** — extend `DeckState`, the reducer, `buildDeckSignal`, and `useDeck` to carry and act on the new fields (`tempo`, `cuePoint`, `loopIn`, `loopOut`, `loopActive`).
2. **Waveform markers** — extend `Waveform.tsx` to accept and draw cue/loop region overlays on the offscreen canvas.
3. **Tempo control UI** — add a tempo knob/slider to `DeckControls.tsx`.
4. **Cue & loop UI** — add buttons to `DeckPanel.tsx` (Set Cue, Cue, Loop In, Loop Out, Loop toggle).

Each sub-task below is self-contained: it touches a defined set of files, produces a visible/audible checkpoint, and can be reviewed before the next one begins.

---

## Sub-Task 1 — Varispeed Tempo

### Intent
Wire up the existing `tempo` field in `DeckState` to actually change playback speed. The audio graph already computes `incPerSample = s.tempo / (totalFrames - 1)` in `buildDeckSignal` — so tempo is latent. This sub-task adds reducer actions, a `setTempo` hook method, and a UI control.

### Expected Outcomes
- Dragging a tempo control smoothly changes playback speed (pitch shifts with it — varispeed, as per the spec's scope decision).
- The tempo knob resets to 1.0 on double-click.
- No audio clicks: Elementary diffs the const node and ramps the value.

### Todo List
1. **`deck.ts`** — Add a `SET_TEMPO` action case to the reducer in `useDeck.ts` that clamps tempo to a sensible range (e.g. `0.5–2.0`).
2. **`useDeck.ts`** — Add a `setTempo(value: number)` method to the `UseDeck` interface and hook; dispatch `SET_TEMPO`.
3. **`DeckControls.tsx`** — Add a `TEMPO` knob (or horizontal slider) below the FILTER knob, range `0.5–2.0`, default `1.0`, `format` showing `±%` deviation (e.g. `+5%`, `-12%`).
4. **`index.css`** — Add any needed style for the tempo control row (likely reuses `.knob` class, no new CSS needed).

### Relevant Context
- [`deck.ts`](src/deck.ts:122) — `incPerSample = s.tempo / Math.max(1, totalFrames - 1)` already uses `tempo`.
- [`useDeck.ts`](src/useDeck.ts:36) — `LOAD` action resets `tempo: 1` already.
- [`DeckControls.tsx`](src/components/DeckControls.tsx) — existing knob layout to follow.

### Status
`[x] complete`

---

## Sub-Task 2 — Loop State: DeckState & Audio Graph

### Intent
Add loop fields (`loopIn`, `loopOut`, `loopActive`) to `DeckState`, the initial state, and the reducer, and implement the floored-modulo loop wrap inside `buildDeckSignal` in `deck.ts`.

The SPEC describes the loop wrap technique precisely (§6):
> Looping wraps the phase into `[loopIn, loopOut)` with a **floored modulo** (`x − len·floor(x/len)`), because `el.mod` is `fmod` and keeps the dividend's sign. Built structurally from a JS flag, so toggling the loop reshapes the graph while the accumulator keeps its state. Loop *exit* re-bases the transport in JS so playback continues from the current spot rather than the run-on phase.

### Expected Outcomes
- When `loopActive` is `true`, the deck's position wraps continuously between `loopIn` and `loopOut` at audio rate — no click, no glitch.
- When loop is toggled off while playing, the transport continues from the current playhead position (not from `loopIn`).
- `loopIn` and `loopOut` default to `null` (unset).

### Todo List
1. **`deck.ts`** — Add `loopIn: number | null`, `loopOut: number | null`, `loopActive: boolean` to `DeckState` interface.
2. **`deck.ts`** — Update `initialDeckState` with the new fields defaulting to `null`, `null`, `false`.
3. **`deck.ts`** — In `buildDeckSignal`, when `loopActive && loopIn !== null && loopOut !== null`: compute the floored-modulo wrap of `position` into `[loopIn, loopOut)` using `el.sub(pos, el.mul(len, el.floor(el.div(el.sub(pos, loopIn), len))))` (where `len = loopOut - loopIn`). Use keyed const nodes for `loopIn`, `loopOut`, and `len` so they update cleanly.
4. **`useDeck.ts`** — Add `SET_LOOP_IN`, `SET_LOOP_OUT`, `SET_LOOP_ACTIVE`, and `CLEAR_LOOP` action cases to the reducer.
5. **`useDeck.ts`** — When toggling `loopActive` from `true` → `false` while playing, dispatch a `SEEK` to the current `position` (rebase the transport) so playback continues forward from where the loop was.
6. **`useDeck.ts`** — Add `setLoopIn`, `setLoopOut`, `toggleLoop`, `clearLoop` to the `UseDeck` interface and hook.

### Relevant Context
- [`deck.ts`](src/deck.ts:118-149) — `buildDeckSignal` and the transport/position pipeline.
- [`deck.ts`](src/deck.ts:127-128) — `el.const` keying pattern to follow.
- [`useDeck.ts`](src/useDeck.ts:20-54) — reducer action union and switch.
- SPEC §6 — exact floored-modulo formula and loop-exit re-base requirement.

### Status
`[x] complete`

---

## Sub-Task 3 — Cue Point State & Audio

### Intent
Add a single in-mix cue point (`cuePoint: number | null`) to `DeckState`. The cue point is set to the current playhead position and can be jumped back to at any time (including while playing — a "stutter cue").

### Expected Outcomes
- `setCuePoint()` captures the current live `position` into `DeckState.cuePoint`.
- `jumpToCue()` seeks the deck to `cuePoint` (dispatches `SEEK`), which resets the accumulator via `seekGen` — no separate audio-graph change needed.
- `cuePoint` is cleared (`null`) when a new track loads.

### Todo List
1. **`deck.ts`** — Add `cuePoint: number | null` to `DeckState` interface and `initialDeckState` (defaults `null`).
2. **`useDeck.ts`** — Add `SET_CUE` action that sets `cuePoint` to a given normalized position; clear it in the `LOAD` action.
3. **`useDeck.ts`** — Add `setCuePoint()` method that dispatches `SET_CUE` with the current live `position` ref value.
4. **`useDeck.ts`** — Add `jumpToCue()` method that reads `state.cuePoint` and dispatches `SEEK` to it if set.
5. **`useDeck.ts`** — Expose `setCuePoint` and `jumpToCue` on the `UseDeck` interface.

### Relevant Context
- [`useDeck.ts`](src/useDeck.ts:71) — live `position` state is available to the hook.
- [`useDeck.ts`](src/useDeck.ts:122-125) — `seek()` pattern to reuse.
- SPEC §2 — "In-mix cue point only, no headphone bus" scope decision.

### Status
`[x] complete`

---

## Sub-Task 4 — Waveform Markers (Cue & Loop Region)

### Intent
Extend `Waveform.tsx` to draw cue and loop markers on the waveform canvas: a vertical cue line, a colored loop region (semi-transparent fill between `loopIn` and `loopOut`), and vertical lines at the loop boundaries. These are drawn on the live canvas each frame (not the offscreen cache) so they track zoom correctly.

### Expected Outcomes
- The cue marker appears as a distinct vertical line (e.g. yellow/orange) at the cue position within the visible window.
- The loop region fills the area between `loopIn` and `loopOut` with a semi-transparent colored overlay; loop boundary lines are clearly visible.
- When zoomed in, the markers move correctly within the visible window (same math as the playhead line).
- When `cuePoint` or loop bounds are `null`, nothing extra is drawn.

### Todo List
1. **`Waveform.tsx`** — Extend the `Props` interface to accept `cuePoint: number | null`, `loopIn: number | null`, `loopOut: number | null`, `loopActive: boolean`.
2. **`Waveform.tsx`** — In the `draw` callback, after drawing the playhead, add:
   - A loop region fill (`ctx.fillRect`) between `loopIn` and `loopOut` using a semi-transparent color (e.g. `rgba(76,194,255,0.15)` for inactive, `rgba(76,194,255,0.3)` for active loop).
   - Vertical loop-in and loop-out lines (e.g. cyan, 1px).
   - A vertical cue line (e.g. orange `#ffaa33`, 2px).
   - All positions converted to canvas X using the same `((norm * total - start) / win) * cssW` formula used for the playhead.
3. **`DeckPanel.tsx`** — Pass the new props (`cuePoint`, `loopIn`, `loopOut`, `loopActive`) from `deck.state` into `<Waveform>`.
4. **`index.css`** — No new CSS needed; marker colors are applied inline in canvas code.

### Relevant Context
- [`Waveform.tsx`](src/components/Waveform.tsx:82-126) — `draw` callback and the `((position * total - start) / win) * cssW` formula to follow for marker X positions.
- [`Waveform.tsx`](src/components/Waveform.tsx:17-19) — current `Props` interface to extend.
- [`DeckPanel.tsx`](src/components/DeckPanel.tsx:63) — existing `<Waveform>` call site.

### Status
`[x] complete`

---

## Sub-Task 5 — Cue & Loop UI Buttons

### Intent
Add transport-area buttons in `DeckPanel.tsx` for all four P4 controls: **Set Cue**, **Cue** (jump), **Loop In**, **Loop Out**, and **Loop** (toggle active/off). This is the final wiring — the audio and state are already complete after sub-tasks 1–4.

### Expected Outcomes
- **Set Cue**: captures the current playhead as the cue point (calls `setCuePoint()`). Disabled when no track loaded.
- **Cue**: jumps to the stored cue point (calls `jumpToCue()`). Disabled when no cue point is set.
- **Loop In**: sets `loopIn` to the current playhead position. Disabled when no track loaded.
- **Loop Out**: sets `loopOut` to the current playhead position (and auto-activates the loop if both `loopIn` and `loopOut` are now set). Disabled when `loopIn` is not yet set.
- **Loop**: toggles `loopActive`. Visually highlighted (active styling) when loop is on.
- All buttons fit compactly in the existing transport row or in a new `cue-loop-row` beneath it.

### Todo List
1. **`DeckPanel.tsx`** — Import the new methods (`setCuePoint`, `jumpToCue`, `setLoopIn`, `setLoopOut`, `toggleLoop`) from `deck` (they live on `UseDeck` after sub-tasks 2–3).
2. **`DeckPanel.tsx`** — Add a second row of small buttons below the transport row: `[Set Cue]` `[Cue]` `[Loop In]` `[Loop Out]` `[Loop]`.
3. **`DeckPanel.tsx`** — On **Loop Out** click: call `setLoopOut(position)` then, if `deck.state.loopIn !== null`, also call `toggleLoop()` to start the loop automatically.
4. **`index.css`** — Add `.cue-loop-row` flex row and `.btn.active` style (accent background, used for the Loop button when `loopActive` is `true`).

### Relevant Context
- [`DeckPanel.tsx`](src/components/DeckPanel.tsx:66-78) — existing transport row to extend below.
- [`useDeck.ts`](src/useDeck.ts:57-67) — `UseDeck` interface to reference for the new methods added in sub-tasks 2 & 3.
- [`index.css`](src/index.css:75-113) — existing `.btn` / `.btn.ghost` variants to follow for the new `.btn.active`.

### Status
`[x] complete`

---

## Dependency Order

```
Sub-Task 1 (Tempo)        — independent, safe to do first
Sub-Task 2 (Loop state)   — must come before Sub-Task 4 and 5
Sub-Task 3 (Cue state)    — must come before Sub-Task 4 and 5
Sub-Task 4 (Waveform)     — requires Sub-Tasks 2 & 3 to have extended DeckState
Sub-Task 5 (UI buttons)   — requires Sub-Tasks 2 & 3 for the hook methods
```

The safe implementation order is: **1 → 2 → 3 → 4 → 5**.

---

## Files Changed Summary

| File | Sub-Tasks |
|------|-----------|
| `src/deck.ts` | 1, 2, 3 |
| `src/useDeck.ts` | 1, 2, 3 |
| `src/components/DeckControls.tsx` | 1 |
| `src/components/Waveform.tsx` | 4 |
| `src/components/DeckPanel.tsx` | 4, 5 |
| `src/index.css` | 5 |

No changes are needed to `App.tsx`, `audio.ts`, `track.ts`, `Mixer.tsx`, `Knob.tsx`, or `Fader.tsx`.
