# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server at http://localhost:3000 (hot reload)
npm run build     # Production build → dist/
npm run preview   # Serve the dist/ build locally
```

No linter, formatter, or test runner is configured. There is no test suite.

**Double-click launcher (macOS):** `/Users/ssl/Desktop/Lift Station Sizer.command` — kills any existing process on port 3000, starts `npm run dev`, then opens the browser automatically once the server is ready.

## Architecture

The entire application is a single React component: `src/components/LiftStationSizer.jsx` (~1 500 lines). `src/App.jsx` is a thin shell that renders it. There are no external state libraries, no routing, and no API calls.

### Layout

Three side-by-side panels, all inline-styled (no CSS files, no Tailwind):

| Panel | Contents |
|---|---|
| Left (250 px) | Wet Well, Pump, and Water Level settings |
| Center | Interactive SVG cross-section diagram + simulation control bar |
| Right (310 px) | Floats, Inlets, Volumes, Summary, and Simulation sections — user-reorderable |

### Theming

A `DARK` and `LIGHT` token object live at module scope. `makeStyles(T)` produces the full styles object from a token set. At the top of the component's render path (just before `return`), `T`, `styles`, and `S` are reassigned to the current theme:

```js
const T = isDark ? DARK : LIGHT;
styles = makeStyles(T);
S = { note: { fontSize: 10, color: T.textFaint, marginTop: 2 } };
```

`styles` and `S` are module-level `let` variables so sub-components (`Section`, `Row`, `NumInput`, etc.) pick them up without prop-drilling. All SVG fill/stroke colors reference `T.xxx` directly in JSX.

### SVG Diagram

- `viewBox="0 0 460 580"` with dynamic `width={SVG_W * svgScale}` / `height={SVG_H * svgScale}` — all coordinate math uses viewBox units, so scaling is free.
- `toY(elev)` converts an absolute elevation (ft) to SVG pixel Y.
- Key layout constants: `ML=60` (left margin / elev axis), `MT=30`, `MB=55`, `DH=495` (usable height), `WELL_LEFT=130`, `WELL_RIGHT=290`.
- Drag handles are plain SVG elements with `onMouseDown` → sets `dragging.current`. A window-level `mousemove` listener in a `useEffect` reads `stateRef.current` (kept fresh every render) to avoid stale closures.
- Corner scale grip: `dragging.current = { type:'scale', startX, startY, startScale }` — the same mousemove handler handles it.
- **Inlet elevation = true invert** (inside-bottom of pipe). The pipe rect draws *upward* from `iy`: `y={iy - ph}`, height `ph`. The drag handle sits at `cy={iy}`.

### Simulation Engine

`runSimStep(prev, inlets, floats, wetWell)` is a pure function at module scope — no component closures — called from a `setInterval` via `setSim(prev => runSimStep(...))`.

- Tick: 50 ms real time × `speedMultiplier` = simulated seconds per tick.
- **Time-weighted inflow**: integrates `from/to/frac` across each tick boundary so a 1-min / 400-gpm inlet always delivers exactly 400 gal.
- **Pump hysteresis**: pumps latch ON when water reaches their float elevation; all latched pumps turn OFF together when water drops to the lowest float elevation.
- `sim.completed` flag distinguishes a finished run from a mid-run pause — used to decide "▶ RUN AGAIN" vs "▶ RESUME" and to trigger a fresh start in `handleSimPlay`.

### Float Type System

`FLOAT_TYPES` (7 entries) defines `value`, `label`, `color`, `hasPump`, and a `note(f)` function. `ftDef(type)` looks up the definition. Selecting a type auto-updates `name`, `color`, and zeroes `pumpDischarge` if `!hasPump`.

### Persistence

All user-configurable state is saved to `localStorage` with the prefix `ls-sizer-` via `loadLS` / `saveLS` helpers. Simulation state is intentionally excluded. Keys: `wetWell`, `floats`, `inlets`, `waterLevel`, `nextId`, `pump`, `svgScale`, `rightOrder`, `isDark`.

### Sub-components

All defined at the bottom of the same file: `Section`, `Row`, `Pair`, `U`, `NumInput`, `Btn`, `DelBtn`, `SumRow`. They read `styles` and `S` from module scope — do not pass styles as props.
