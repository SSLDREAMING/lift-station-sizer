import { useState, useRef, useEffect } from 'react';

const SVG_W = 460;
const SVG_H = 580;
const ML    = 60;   // left margin: elevation labels
const MT    = 30;   // top margin
const MB    = 55;   // bottom margin: width annotation
const DH    = SVG_H - MT - MB;  // 495 usable diagram height

const WELL_PX_W = 160;
const WELL_LEFT  = 130;
const WELL_RIGHT = WELL_LEFT + WELL_PX_W;  // 290

const SIM_TICK_MS = 50;
const GPF = 7.48052;  // gallons per cubic foot

// ─── Standalone simulation step (no closures) ───────────────────────────────
// Pump hysteresis: a pump latches ON when water reaches its float elevation.
// It stays ON until water drops back to the lowest float elevation (Pump OFF level).
// This mirrors real lift-station behaviour.
function runSimStep(prev, inlets, floats, wetWell) {
  const dt    = (SIM_TICK_MS / 1000) * prev.speedMultiplier;
  const t     = prev.elapsedTime + dt;
  const wl    = prev.waterLevel;
  const prevT = prev.elapsedTime;

  // Time-weighted inflow — exact boundary handling when inlet starts/ends mid-tick.
  // Instead of a point sample at t, we compute the fraction of dt the inlet was actually
  // flowing, so a 1-minute inlet at 400 gpm yields exactly 400 gal regardless of tick size.
  const totalIn = inlets.reduce((sum, i) => {
    const from = Math.max(i.startTime, prevT);
    const to   = Math.min(i.startTime + i.duration, t);
    const frac = dt > 0 ? Math.max(0, to - from) / dt : 0;
    return sum + i.flowRate * frac;
  }, 0);

  // ── Hysteresis pump logic ──────────────────────────────────────────────────
  // OFF level = lowest float elevation (all latched pumps turn off here)
  const offElev = floats.reduce((min, f) => Math.min(min, f.elevation), Infinity);

  let newActivePumpIds = [...prev.activePumpIds];

  // Latch ON any pump float that water has now reached (rising edge)
  floats.forEach(f => {
    if (f.pumpDischarge > 0 && wl >= f.elevation && !newActivePumpIds.includes(f.id)) {
      newActivePumpIds.push(f.id);
    }
  });

  // Total discharge from all latched-on pumps
  const totalOut = floats
    .filter(f => newActivePumpIds.includes(f.id))
    .reduce((sum, f) => sum + f.pumpDischarge, 0);

  // Compute new water level
  const netGpm   = totalIn - totalOut;
  const wellArea = Math.PI * (wetWell.width / 2) ** 2;
  const dH       = (netGpm / GPF / 60 / wellArea) * dt;
  const minWL    = wetWell.bottomElev;
  const maxWL    = wetWell.bottomElev + wetWell.depth;
  const newWL    = Math.max(minWL, Math.min(maxWL, wl + dH));

  // Latch OFF: all pumps turn off when water drops to (or below) the OFF level
  const allPumpsOff = newActivePumpIds.length > 0 && newWL <= offElev;

  // Event detection
  const newEvents = [...prev.events];

  inlets.forEach(i => {
    const wasOn = prevT >= i.startTime && prevT < i.startTime + i.duration;
    const nowOn =    t >= i.startTime &&    t < i.startTime + i.duration;
    if (!wasOn && nowOn) newEvents.push({ t, type: 'in',   msg: `${i.name} starts · +${i.flowRate} gpm` });
    if (wasOn && !nowOn) newEvents.push({ t, type: 'in',   msg: `${i.name} stops` });
  });

  // Log pump-ON events (newly latched)
  floats.forEach(f => {
    if (f.pumpDischarge > 0 && !prev.activePumpIds.includes(f.id) && newActivePumpIds.includes(f.id)) {
      newEvents.push({ t, type: 'pump', msg: `${f.name} reached → pump ON (+${f.pumpDischarge} gpm)` });
    }
  });

  // Log all-pumps-off event
  if (allPumpsOff) {
    newEvents.push({ t, type: 'pump', msg: `All pumps OFF — WL returned to ${newWL.toFixed(2)}′` });
    newActivePumpIds = [];
  }

  if (newWL >= maxWL && wl < maxWL)
    newEvents.push({ t, type: 'warn', msg: '⚠ OVERFLOW — water at well top!' });

  const newHistory = [
    ...prev.flowHistory.slice(-599),
    { t, wl: newWL, totalIn, totalOut: allPumpsOff ? 0 : totalOut, netGpm },
  ];

  // Auto-stop: all inlets done + water back at OFF level + no pumps running
  const maxEnd = inlets.reduce((m, i) => Math.max(m, i.startTime + i.duration), 0);
  const done   = t > maxEnd + 5 && newActivePumpIds.length === 0 && newWL <= offElev + 0.05;

  return {
    ...prev,
    elapsedTime:     t,
    waterLevel:      newWL,
    activePumpIds:   newActivePumpIds,
    events:          newEvents,
    flowHistory:     newHistory,
    isRunning:       done ? false : prev.isRunning,
    completed:       done ? true : prev.completed,
    cumulativeGalIn: (prev.cumulativeGalIn || 0) + totalIn * (dt / 60),
  };
}

function fmtTime(s) {
  return `${(s / 60).toFixed(1)} min`;
}

// ─── localStorage helpers ─────────────────────────────────────────────────────
const LS = 'ls-sizer-';
function loadLS(key, def) {
  try { const v = localStorage.getItem(LS + key); return v ? JSON.parse(v) : def; } catch { return def; }
}
function saveLS(key, val) {
  try { localStorage.setItem(LS + key, JSON.stringify(val)); } catch {}
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function LiftStationSizer() {
  const [wetWell, setWetWell] = useState(() => loadLS('wetWell', { width: 6, depth: 15, bottomElev: 95.0 }));
  const [floats, setFloats] = useState(() => loadLS('floats', [
    { id: 1, name: 'Pump OFF',  elevation: 97.5,  color: '#22c55e', pumpDischarge: 0   },
    { id: 2, name: 'Pump ON',   elevation: 99.5,  color: '#ef4444', pumpDischarge: 450 },
    { id: 3, name: 'Hi-Water',  elevation: 101.5, color: '#f59e0b', pumpDischarge: 0   },
  ]));
  const [inlets, setInlets] = useState(() => loadLS('inlets', [
    { id: 1, name: 'Inlet 1', elevation: 103.0, diameter: 8, flowRate: 500, startTime: 0, duration: 300 },
  ]));
  const [waterLevel, setWaterLevel] = useState(() => loadLS('waterLevel', 100.0));
  const [nextId, setNextId] = useState(() => loadLS('nextId', 4));
  const [pump, setPump] = useState(() => loadLS('pump', { baseOffset: 0, height: 3 }));
  const [svgScale, setSvgScale] = useState(() => loadLS('svgScale', 1.0));
  const [rightOrder, setRightOrder] = useState(() => loadLS('rightOrder', ['floats', 'inlets', 'volumes', 'summary', 'simulation']));

  const [sim, setSim] = useState({
    isRunning:       false,
    elapsedTime:     0,
    waterLevel:      null,   // null = not started; number = live sim WL
    speedMultiplier: 10,
    events:          [],
    flowHistory:     [],
    activePumpIds:   [],     // IDs of pump floats currently latched ON
    cumulativeGalIn: 0,      // total gallons that have entered the well
    completed:       false,  // true once auto-stop fires — signals "run again" not "resume"
  });

  const dragging   = useRef(null);
  const svgRef     = useRef(null);
  const stateRef   = useRef({});
  const simInputRef = useRef({});

  // ── Scale helpers ──────────────────────────────────────────────────────────
  const topElev   = wetWell.bottomElev + wetWell.depth + 2;
  const botShown  = wetWell.bottomElev - 1;
  const elevRange = topElev - botShown;
  const pxPerFt   = DH / elevRange;

  const toY    = (elev) => MT + (topElev - elev) * pxPerFt;

  const wellTopY = toY(wetWell.bottomElev + wetWell.depth);
  const wellBotY = toY(wetWell.bottomElev);

  // Keep refs fresh every render
  stateRef.current   = { wetWell, topElev, pxPerFt, pump };
  simInputRef.current = { inlets, floats, wetWell };

  // ── Simulation-derived display values ─────────────────────────────────────
  const simActive = sim.waterLevel !== null;
  const displayWL = simActive ? sim.waterLevel : waterLevel;

  const simInletStatus = inlets.map(i => ({
    ...i,
    simOn: simActive && sim.elapsedTime >= i.startTime && sim.elapsedTime < i.startTime + i.duration,
  }));
  // pumpOn = pump is latched on (hysteresis — stays on until water returns to OFF level)
  const simFloatStatus = floats.map(f => ({
    ...f,
    pumpOn: simActive && sim.activePumpIds.includes(f.id),
  }));
  const simTotalIn  = simInletStatus.filter(i => i.simOn).reduce((s, i) => s + i.flowRate, 0);
  const simTotalOut = simFloatStatus.filter(f => f.pumpOn).reduce((s, f) => s + f.pumpDischarge, 0);
  const simNetGpm   = simTotalIn - simTotalOut;

  // ── Clamp elevations when well geometry changes ────────────────────────────
  useEffect(() => {
    const { bottomElev, depth } = wetWell;
    const clamp = (v) => Math.max(bottomElev, Math.min(bottomElev + depth, v));
    setFloats(prev => prev.map(f => ({ ...f, elevation: clamp(f.elevation) })));
    setInlets(prev => prev.map(i => ({ ...i, elevation: clamp(i.elevation) })));
    setWaterLevel(prev => clamp(prev));
    setPump(prev => {
      const base = Math.max(0, Math.min(depth - prev.height, prev.baseOffset));
      const h    = Math.max(0.5, Math.min(depth - base, prev.height));
      return { baseOffset: base, height: h };
    });
  }, [wetWell.bottomElev, wetWell.depth]);

  // ── Window-level drag (registered once, reads stateRef) ───────────────────
  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current || !svgRef.current) return;
      const { wetWell: ww, topElev: te, pxPerFt: ppf } = stateRef.current;
      const rect = svgRef.current.getBoundingClientRect();
      const rawY = (e.clientY - rect.top) * (SVG_H / rect.height);
      const raw  = te - (rawY - MT) / ppf;
      const elev = parseFloat(Math.max(ww.bottomElev, Math.min(ww.bottomElev + ww.depth, raw)).toFixed(2));
      const { type, id } = dragging.current;
      if (type === 'float') setFloats(prev => prev.map(f => f.id === id ? { ...f, elevation: elev } : f));
      if (type === 'inlet') setInlets(prev => prev.map(i => i.id === id ? { ...i, elevation: elev } : i));
      if (type === 'water') setWaterLevel(elev);
      if (type === 'pump-base') {
        const { pump: p } = stateRef.current;
        const clamped = Math.max(0, Math.min(ww.depth - p.height, elev - ww.bottomElev));
        setPump(prev => ({ ...prev, baseOffset: parseFloat(clamped.toFixed(2)) }));
      }
      if (type === 'pump-top') {
        const { pump: p } = stateRef.current;
        const clamped = Math.max(0.5, Math.min(ww.depth - p.baseOffset, elev - (ww.bottomElev + p.baseOffset)));
        setPump(prev => ({ ...prev, height: parseFloat(clamped.toFixed(2)) }));
      }
      if (type === 'scale') {
        const dx = e.clientX - dragging.current.startX;
        const dy = e.clientY - dragging.current.startY;
        const delta = (dx + dy) / 2;
        const newScale = Math.max(0.4, Math.min(3.0, dragging.current.startScale + delta / 260));
        setSvgScale(parseFloat(newScale.toFixed(2)));
      }
    };
    const onUp = () => { dragging.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []);

  // ── Simulation timer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!sim.isRunning) return;
    const timer = setInterval(() => {
      const { inlets: ci, floats: cf, wetWell: cw } = simInputRef.current;
      setSim(prev => runSimStep(prev, ci, cf, cw));
    }, SIM_TICK_MS);
    return () => clearInterval(timer);
  }, [sim.isRunning]);

  // ── Persist user config to localStorage (sim state is intentionally excluded) ──
  useEffect(() => { saveLS('wetWell',    wetWell);    }, [wetWell]);
  useEffect(() => { saveLS('floats',     floats);     }, [floats]);
  useEffect(() => { saveLS('inlets',     inlets);     }, [inlets]);
  useEffect(() => { saveLS('waterLevel', waterLevel); }, [waterLevel]);
  useEffect(() => { saveLS('nextId',     nextId);     }, [nextId]);
  useEffect(() => { saveLS('pump',       pump);       }, [pump]);
  useEffect(() => { saveLS('svgScale',   svgScale);  }, [svgScale]);
  useEffect(() => { saveLS('rightOrder', rightOrder); }, [rightOrder]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const startDrag = (type, id) => (e) => { e.preventDefault(); dragging.current = { type, id }; };

  const addFloat = () => {
    const colors = ['#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316'];
    const elev   = parseFloat((wetWell.bottomElev + wetWell.depth * 0.5).toFixed(2));
    setFloats(prev => [...prev, { id: nextId, name: `Float ${nextId}`, elevation: elev, color: colors[nextId % colors.length], pumpDischarge: 0 }]);
    setNextId(n => n + 1);
  };
  const removeFloat = (id) => setFloats(prev => prev.filter(f => f.id !== id));

  const addInlet = () => {
    const elev = parseFloat((wetWell.bottomElev + wetWell.depth * 0.85).toFixed(2));
    setInlets(prev => [...prev, { id: nextId, name: `Inlet ${nextId}`, elevation: elev, diameter: 8, flowRate: 300, startTime: 0, duration: 180 }]);
    setNextId(n => n + 1);
  };
  const removeInlet = (id) => setInlets(prev => prev.filter(i => i.id !== id));

  const handleSimPlay = () => {
    // Fresh start when: never run yet (waterLevel===null) OR previous run completed
    if (sim.waterLevel === null || sim.completed) {
      const initPumpIds = floats
        .filter(f => f.pumpDischarge > 0 && waterLevel >= f.elevation)
        .map(f => f.id);
      setSim(prev => ({
        ...prev,
        isRunning:       true,
        waterLevel:      waterLevel,
        elapsedTime:     0,
        events:          [],
        flowHistory:     [],
        activePumpIds:   initPumpIds,
        cumulativeGalIn: 0,
        completed:       false,
      }));
    } else {
      // Mid-run: toggle pause / resume
      setSim(prev => ({ ...prev, isRunning: !prev.isRunning }));
    }
  };
  const moveSection = (key, dir) => setRightOrder(prev => {
    const i = prev.indexOf(key);
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const handleSimReset = () => setSim(prev => ({
    isRunning: false, elapsedTime: 0, waterLevel: null,
    speedMultiplier: prev.speedMultiplier, events: [], flowHistory: [],
    activePumpIds: [], cumulativeGalIn: 0, completed: false,
  }));

  // ── Summary calcs ─────────────────────────────────────────────────────────
  const wellArea   = Math.PI * (wetWell.width / 2) ** 2;
  const sortedF    = [...floats].sort((a, b) => a.elevation - b.elevation);
  const offElev    = sortedF[0]?.elevation ?? wetWell.bottomElev;
  const onElev     = sortedF[1]?.elevation ?? offElev + 1;
  const hwaElev    = sortedF[2]?.elevation;
  const cycleVol   = (onElev - offElev) * wellArea * GPF;

  const rawMarkers = [
    { label: 'Well Floor',  elev: wetWell.bottomElev, color: '#475569' },
    ...floats.map(f => ({ label: f.name, elev: f.elevation, color: f.color })),
    { label: 'Water Level', elev: displayWL,           color: '#38bdf8' },
  ]
    .sort((a, b) => a.elev - b.elev)
    .filter((m, i, arr) => i === 0 || Math.abs(m.elev - arr[i - 1].elev) > 0.005);

  const volSegments = rawMarkers.slice(0, -1).map((m, i) => {
    const next = rawMarkers[i + 1];
    const h    = next.elev - m.elev;
    return { from: m, to: next, height: h, gal: h * wellArea * GPF };
  });

  const totalCurrentVol = Math.max(0, displayWL - wetWell.bottomElev) * wellArea * GPF;

  // Gantt scale
  const simMaxTime = Math.max(60, ...inlets.map(i => i.startTime + i.duration));

  // Elevation ticks
  const ticks = [];
  for (let e = Math.ceil(botShown); e <= Math.floor(topElev); e++) ticks.push(e);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>

      {/* ═══ LEFT: Well / Pump / Water Level settings ═══ */}
      <div style={styles.leftPanel}>
        <div style={styles.paneHeader}>WET WELL SETTINGS</div>

        <Section title="WET WELL" accent="#7dd3fc">
          <Row label="Diameter">
            <Pair><NumInput value={wetWell.width} min={2} max={30} step={0.5}
              onChange={v => setWetWell(p => ({ ...p, width: v }))} /><U>ft</U></Pair>
          </Row>
          <Row label="Depth">
            <Pair><NumInput value={wetWell.depth} min={2} max={50} step={0.5}
              onChange={v => setWetWell(p => ({ ...p, depth: v }))} /><U>ft</U></Pair>
          </Row>
          <Row label="Bottom Elev">
            <Pair><NumInput value={wetWell.bottomElev} min={0} max={500} step={0.01}
              onChange={v => setWetWell(p => ({ ...p, bottomElev: v }))} /><U>ft</U></Pair>
          </Row>
        </Section>

        <Section title="PUMP" accent="#7dd3fc">
          <Row label="Base Above Floor">
            <Pair><NumInput value={pump.baseOffset} min={0} max={Math.max(0, wetWell.depth - pump.height)} step={0.1}
              onChange={v => setPump(p => ({ ...p, baseOffset: Math.max(0, Math.min(wetWell.depth - p.height, v)) }))} /><U>ft</U></Pair>
          </Row>
          <input type="range" min={0} max={Math.max(0, wetWell.depth - pump.height)} step={0.1}
            value={pump.baseOffset}
            onChange={e => setPump(p => ({ ...p, baseOffset: parseFloat(e.target.value) }))}
            style={{ width: '100%', accentColor: '#7dd3fc', marginBottom: 8 }} />
          <Row label="Pump Height">
            <Pair><NumInput value={pump.height} min={0.5} max={Math.max(0.5, wetWell.depth - pump.baseOffset)} step={0.1}
              onChange={v => setPump(p => ({ ...p, height: Math.max(0.5, Math.min(wetWell.depth - p.baseOffset, v)) }))} /><U>ft</U></Pair>
          </Row>
          <input type="range" min={0.5} max={Math.max(0.5, wetWell.depth - pump.baseOffset)} step={0.1}
            value={pump.height}
            onChange={e => setPump(p => ({ ...p, height: parseFloat(e.target.value) }))}
            style={{ width: '100%', accentColor: '#7dd3fc', marginBottom: 4 }} />
          <div style={S.note}>
            Base: {(wetWell.bottomElev + pump.baseOffset).toFixed(2)}′ · Top: {(wetWell.bottomElev + pump.baseOffset + pump.height).toFixed(2)}′
          </div>
        </Section>

        <Section title="WATER LEVEL" accent="#38bdf8">
          <Row label="Elevation">
            <Pair><NumInput value={waterLevel}
              min={wetWell.bottomElev} max={wetWell.bottomElev + wetWell.depth} step={0.01}
              onChange={v => setWaterLevel(Math.max(wetWell.bottomElev, Math.min(wetWell.bottomElev + wetWell.depth, v)))} /><U>ft</U></Pair>
          </Row>
          <input type="range"
            min={wetWell.bottomElev} max={wetWell.bottomElev + wetWell.depth} step={0.05}
            value={waterLevel}
            onChange={e => setWaterLevel(parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: '#38bdf8', marginTop: 2 }} />
          <div style={S.note}>
            {(waterLevel - wetWell.bottomElev).toFixed(2)}′ above floor · {totalCurrentVol.toFixed(0)} gal
          </div>
        </Section>
      </div>

      {/* ═══ CENTER: SVG + Simulation controls ═══ */}
      <div style={styles.svgPane}>
        <div style={styles.paneHeader}>LIFT STATION PROFILE</div>

        <div style={{ position: 'relative', display: 'inline-flex', alignSelf: 'flex-start' }}>
        <svg ref={svgRef} viewBox={`0 0 ${SVG_W} ${SVG_H}`} width={SVG_W * svgScale} height={SVG_H * svgScale} style={styles.svg}>

          {/* ── Animation keyframes ── */}
          <defs>
            <style>{`
              /* Inlet pipe: sweeps blue → cyan → blue when flowing */
              @keyframes inletPipe {
                0%, 100% { fill: #1d4ed8; }
                50%       { fill: #0891b2; }
              }
              /* Inlet glow overlay: pulses bright */
              @keyframes inletGlow {
                0%, 100% { opacity: 0.08; }
                50%       { opacity: 0.55; }
              }
              /* Inlet drag handle: pulses cyan ↔ white */
              @keyframes handlePulse {
                0%, 100% { fill: #38bdf8; }
                50%       { fill: #e0f2fe; }
              }
              /* Float ripple ring: expands outward and fades */
              @keyframes floatRipple {
                0%   { r: 9px;  opacity: 0.8; }
                100% { r: 27px; opacity: 0;   }
              }
              /* Float circle fill: pulses between its color and lighter */
              @keyframes floatPulse {
                0%, 100% { fill-opacity: 1;   stroke-width: 2; }
                50%       { fill-opacity: 0.55; stroke-width: 3.5; }
              }
              .inlet-pipe-on   { animation: inletPipe   0.9s ease-in-out infinite; }
              .inlet-glow-on   { animation: inletGlow   0.9s ease-in-out infinite; }
              .inlet-handle-on { animation: handlePulse 0.9s ease-in-out infinite; }
              .float-ripple    { animation: floatRipple 1.4s ease-out  infinite; }
              .float-ripple-2  { animation: floatRipple 1.4s ease-out  infinite 0.7s; }
              .float-pulse     { animation: floatPulse  0.9s ease-in-out infinite; }

              /* In-well flow rate label: fades in/out */
              @keyframes flowBlink {
                0%, 100% { opacity: 0.5; }
                50%       { opacity: 1.0; }
              }
              /* Wave chars chase across left→right, staggered */
              @keyframes wavePing {
                0%, 100% { opacity: 0.15; fill: #38bdf8; }
                50%       { opacity: 1.0;  fill: #bae6fd; }
              }
              .flow-blink  { animation: flowBlink 1.1s ease-in-out infinite; }
              .wave-tilde-1 { animation: wavePing 0.75s ease-in-out infinite; }
              .wave-tilde-2 { animation: wavePing 0.75s ease-in-out infinite 0.25s; }
              .wave-tilde-3 { animation: wavePing 0.75s ease-in-out infinite 0.50s; }
            `}</style>
          </defs>

          {/* Info line */}
          <text x={SVG_W / 2} y={18} textAnchor="middle" fill="#475569" fontSize={10}>
            {wetWell.width}′ Ø wet well · {wetWell.depth}′ deep · Bot El {wetWell.bottomElev.toFixed(2)}′
          </text>

          {/* Elevation scale */}
          <line x1={ML} y1={MT} x2={ML} y2={MT + DH} stroke="#1e3a5f" strokeWidth={1} />
          {ticks.map(t => (
            <g key={t}>
              <line x1={ML - (t % 2 === 0 ? 8 : 4)} y1={toY(t)} x2={ML} y2={toY(t)} stroke="#334155" strokeWidth={1} />
              {t % 2 === 0 && (
                <text x={ML - 10} y={toY(t) + 4} textAnchor="end" fill="#64748b" fontSize={10}>{t}</text>
              )}
            </g>
          ))}
          <text x={10} y={MT + DH / 2} textAnchor="middle" fill="#334155" fontSize={10}
            transform={`rotate(-90 10 ${MT + DH / 2})`}>ELEV (ft)</text>

          {/* Ground hatch */}
          <line x1={WELL_LEFT - 25} y1={wellTopY} x2={WELL_RIGHT + 20} y2={wellTopY}
            stroke="#78716c" strokeWidth={1} strokeDasharray="5,4" />
          {[-20, -2, 16, 34, 52, 70, 88].map((dx, i) => (
            <line key={i} x1={WELL_LEFT + dx} y1={wellTopY} x2={WELL_LEFT + dx - 8} y2={wellTopY + 9}
              stroke="#6b5c45" strokeWidth={1} />
          ))}
          <text x={WELL_LEFT - 27} y={wellTopY - 5} textAnchor="end" fill="#78716c" fontSize={9}>GRD</text>

          {/* Water fill — uses displayWL */}
          {displayWL > wetWell.bottomElev && (() => {
            const cx      = (WELL_LEFT + WELL_RIGHT) / 2;
            const innerRX = WELL_PX_W / 2;
            const wlY     = toY(Math.min(displayWL, wetWell.bottomElev + wetWell.depth));
            return (
              <>
                <rect x={WELL_LEFT} y={wlY} width={WELL_PX_W} height={wellBotY - wlY}
                  fill="#1e3a8a" opacity={0.65} />
                <ellipse cx={cx} cy={wellBotY} rx={innerRX} ry={10} fill="#1e3a8a" opacity={0.65} />
              </>
            );
          })()}

          {/* Cylindrical wet well walls */}
          {(() => {
            const cx         = (WELL_LEFT + WELL_RIGHT) / 2;
            const eRY        = 10;
            const wallT      = 7;
            const innerRX    = WELL_PX_W / 2;
            const outerRX    = WELL_PX_W / 2 + wallT;
            const isSubmerged = displayWL > wetWell.bottomElev;
            return (
              <>
                <rect x={WELL_LEFT - wallT} y={wellTopY} width={wallT}  height={wellBotY - wellTopY} fill="#2d3f55" />
                <rect x={WELL_RIGHT}        y={wellTopY} width={wallT}  height={wellBotY - wellTopY} fill="#2d3f55" />
                <ellipse cx={cx} cy={wellBotY} rx={outerRX} ry={eRY + wallT / 2} fill="#2d3f55" />
                <ellipse cx={cx} cy={wellBotY} rx={innerRX} ry={eRY}
                  fill={isSubmerged ? '#1e3a8a' : '#0d1a2d'} opacity={isSubmerged ? 0.65 : 1} />
                <ellipse cx={cx} cy={wellTopY} rx={outerRX} ry={eRY + wallT / 2} fill="#2d3f55" />
                <ellipse cx={cx} cy={wellTopY} rx={innerRX} ry={eRY} fill="#0d1a2d" />
              </>
            );
          })()}

          {/* Pump body */}
          {(() => {
            const cx        = (WELL_LEFT + WELL_RIGHT) / 2;
            const pumpW     = WELL_PX_W * 0.44;
            const pumpLeft  = cx - pumpW / 2;
            const baseAbsEl = wetWell.bottomElev + pump.baseOffset;
            const topAbsEl  = baseAbsEl + pump.height;
            const pBaseY    = toY(baseAbsEl);
            const pTopY     = toY(topAbsEl);
            const bodyH     = pBaseY - pTopY;
            return (
              <>
                <line x1={cx} y1={pTopY} x2={cx} y2={pTopY - 18}
                  stroke="#475569" strokeWidth={4} strokeLinecap="round" />
                <rect x={pumpLeft} y={pTopY} width={pumpW} height={bodyH}
                  fill="#162032" stroke="#475569" strokeWidth={1.5} rx={3} />
                {bodyH > 18 && (
                  <text x={cx} y={(pTopY + pBaseY) / 2 + 4} textAnchor="middle"
                    fill="#475569" fontSize={9} fontWeight="bold" letterSpacing={1}>PUMP</text>
                )}
                {bodyH > 34 && (
                  <>
                    <rect x={cx - 26} y={pTopY + 13}  width={52} height={13} rx={3} fill="#0a0f1e" opacity={0.75} />
                    <text x={cx} y={pTopY + 23} textAnchor="middle" fill="#7dd3fc" fontSize={10} fontWeight="700">{topAbsEl.toFixed(2)}′</text>
                    <rect x={cx - 26} y={pBaseY - 26} width={52} height={13} rx={3} fill="#0a0f1e" opacity={0.75} />
                    <text x={cx} y={pBaseY - 16} textAnchor="middle" fill="#7dd3fc" fontSize={10} fontWeight="700">{baseAbsEl.toFixed(2)}′</text>
                  </>
                )}
                <circle cx={cx} cy={pBaseY} r={6} fill="#1e293b" stroke="#38bdf8" strokeWidth={2}
                  style={{ cursor: 'ns-resize' }} onMouseDown={startDrag('pump-base', null)} />
                <circle cx={cx} cy={pTopY}  r={6} fill="#1e293b" stroke="#7dd3fc" strokeWidth={2}
                  style={{ cursor: 'ns-resize' }} onMouseDown={startDrag('pump-top',  null)} />
              </>
            );
          })()}

          {/* Bottom invert + width dimension */}
          <text x={(WELL_LEFT + WELL_RIGHT) / 2} y={wellBotY + 20} textAnchor="middle" fill="#64748b" fontSize={10}>
            INV {wetWell.bottomElev.toFixed(2)}′
          </text>
          <line x1={WELL_LEFT}  y1={wellBotY + 33} x2={WELL_RIGHT} y2={wellBotY + 33} stroke="#334155" strokeWidth={1} />
          <line x1={WELL_LEFT}  y1={wellBotY + 29} x2={WELL_LEFT}  y2={wellBotY + 37} stroke="#334155" strokeWidth={1} />
          <line x1={WELL_RIGHT} y1={wellBotY + 29} x2={WELL_RIGHT} y2={wellBotY + 37} stroke="#334155" strokeWidth={1} />
          <text x={(WELL_LEFT + WELL_RIGHT) / 2} y={wellBotY + 48} textAnchor="middle" fill="#64748b" fontSize={10}>
            {wetWell.width}′ Ø
          </text>

          {/* Inlet-to-inlet dimension arrows — dimension line left of pipe, label to its right */}
          {inlets.length >= 2 && (() => {
            const sorted = [...inlets].sort((a, b) => a.elevation - b.elevation);
            const xDim   = ML + 14;   // vertical arrow line, just right of the elevation axis
            return sorted.slice(0, -1).map((lower, i) => {
              const upper = sorted[i + 1];
              const yTop  = toY(upper.elevation);
              const yBot  = toY(lower.elevation);
              const pixH  = yBot - yTop;
              if (pixH < 8) return null;
              const midY = (yTop + yBot) / 2;
              const dist = (upper.elevation - lower.elevation).toFixed(2);
              return (
                <g key={`idim-${i}`} style={{ pointerEvents: 'none' }}>
                  {/* Short tick leaders from axis to dim line */}
                  <line x1={ML} y1={yTop} x2={xDim + 3} y2={yTop} stroke="#334155" strokeWidth={0.75} strokeDasharray="3,2" />
                  <line x1={ML} y1={yBot} x2={xDim + 3} y2={yBot} stroke="#334155" strokeWidth={0.75} strokeDasharray="3,2" />
                  {/* Vertical span arrow */}
                  <line x1={xDim} y1={yTop} x2={xDim} y2={yBot} stroke="#7dd3fc" strokeWidth={1.5} />
                  <polygon points={`${xDim},${yTop} ${xDim-3},${yTop+7} ${xDim+3},${yTop+7}`} fill="#7dd3fc" />
                  <polygon points={`${xDim},${yBot} ${xDim-3},${yBot-7} ${xDim+3},${yBot-7}`} fill="#7dd3fc" />
                  {/* Distance label — only when enough room; no box, floats right of arrow line */}
                  {pixH >= 28 && (
                    <text x={xDim + 5} y={midY + 4} textAnchor="start"
                      fill="#7dd3fc" fontSize={9} fontWeight="700">{dist}′</text>
                  )}
                </g>
              );
            });
          })()}

          {/* Inlets — elevation = true invert (inside-bottom of pipe).
               Pipe draws upward from iy (invert) so the bottom edge sits at the entered elevation. */}
          {simInletStatus.map(inlet => {
            const iy = toY(inlet.elevation);          // pixel y of the invert
            const ph = Math.max(5, inlet.diameter * 1.5);
            const pw = WELL_LEFT - ML - 12;
            const pipeTop = iy - ph;                  // top of pipe in pixels (higher elev)
            return (
              <g key={inlet.id}>
                {/* Pipe body — bottom edge at invert (iy), draws upward */}
                <rect x={ML + 4} y={pipeTop} width={pw} height={ph}
                  rx={ph / 2} opacity={inlet.simOn ? 1 : 0.85}
                  className={inlet.simOn ? 'inlet-pipe-on' : undefined}
                  fill={inlet.simOn ? undefined : '#1d4ed8'} />
                {/* Pulsing glow overlay when active */}
                {inlet.simOn && (
                  <rect x={ML + 4} y={pipeTop} width={pw} height={ph}
                    fill="#7dd3fc" rx={ph / 2}
                    className="inlet-glow-on" />
                )}
                {/* Drag handle at invert elevation — pulses cyan↔white when active */}
                <circle cx={WELL_LEFT - 5} cy={iy} r={7}
                  fill={inlet.simOn ? undefined : '#3b82f6'}
                  stroke="#bfdbfe" strokeWidth={1.5}
                  className={inlet.simOn ? 'inlet-handle-on' : undefined}
                  style={{ cursor: 'ns-resize' }}
                  onMouseDown={startDrag('inlet', inlet.id)} />
                {/* Name centered inside pipe body */}
                <text x={ML + 4 + pw / 2} y={iy - ph / 2 + 3} textAnchor="middle"
                  fill={inlet.simOn ? '#e0f2fe' : '#bfdbfe'} fontSize={8} fontWeight="bold"
                  style={{ pointerEvents: 'none' }}>
                  {inlet.name}
                </text>
                {/* Compact info line just above the pipe — small so it doesn't crowd */}
                <text x={ML + 5} y={pipeTop - 2} fill={inlet.simOn ? '#7dd3fc' : '#60a5fa'} fontSize={7}>
                  {inlet.diameter}″Ø · INV {inlet.elevation.toFixed(2)}′
                </text>
                {/* Flow animation inside the wet well — wave chars + rate label */}
                {inlet.simOn && (() => {
                  const wcx = (WELL_LEFT + WELL_RIGHT) / 2;
                  const wcy = iy - ph / 2;          // vertical centre of inlet pipe
                  const rw  = 94; const rh = 24;    // pill size
                  return (
                    <g style={{ pointerEvents: 'none' }}>
                      {/* Dark pill background */}
                      <rect x={wcx - rw / 2} y={wcy - rh / 2} width={rw} height={rh}
                        rx={rh / 2} fill="#071220" opacity={0.88}
                        className="flow-blink" />
                      {/* Three staggered wave tildes */}
                      <text x={wcx - 38} y={wcy + 5} fontSize={14} fontWeight="900"
                        className="wave-tilde-1">~</text>
                      <text x={wcx - 26} y={wcy + 5} fontSize={14} fontWeight="900"
                        className="wave-tilde-2">~</text>
                      <text x={wcx - 14} y={wcy + 5} fontSize={14} fontWeight="900"
                        className="wave-tilde-3">~</text>
                      {/* Flow rate */}
                      <text x={wcx - 1} y={wcy + 5} fill="#e0f2fe" fontSize={10} fontWeight="700"
                        className="flow-blink">
                        {inlet.flowRate} gpm
                      </text>
                    </g>
                  );
                })()}
              </g>
            );
          })}

          {/* Water Level line — displayWL; drag disabled during sim */}
          <line
            x1={WELL_LEFT - 14} x2={WELL_RIGHT + 14}
            y1={toY(displayWL)}  y2={toY(displayWL)}
            stroke="#38bdf8" strokeWidth={simActive ? 2.5 : 2} strokeDasharray="6,3"
            style={{ cursor: simActive ? 'default' : 'ns-resize' }}
            onMouseDown={simActive ? undefined : startDrag('water', null)}
          />
          {!simActive && (
            <polygon
              points={`${WELL_LEFT-15},${toY(displayWL)-6} ${WELL_LEFT-15},${toY(displayWL)+6} ${WELL_LEFT-6},${toY(displayWL)}`}
              fill="#38bdf8" style={{ cursor: 'ns-resize' }}
              onMouseDown={startDrag('water', null)}
            />
          )}
          <text x={WELL_LEFT - 17} y={toY(displayWL) - 8}  textAnchor="end" fill="#38bdf8" fontSize={9}>WL</text>
          <text x={WELL_LEFT - 17} y={toY(displayWL) + 15} textAnchor="end" fill="#38bdf8" fontSize={9}>{displayWL.toFixed(2)}′</text>

          {/* Sim: net-flow status pill */}
          {simActive && (
            <g style={{ pointerEvents: 'none' }}>
              <rect x={WELL_LEFT + 20} y={MT + 2} width={WELL_PX_W - 40} height={16} rx={4} fill="#0a0f1e" opacity={0.9} />
              <text x={(WELL_LEFT + WELL_RIGHT) / 2} y={MT + 14} textAnchor="middle" fontSize={10} fontWeight="700"
                fill={simNetGpm > 5 ? '#38bdf8' : simNetGpm < -5 ? '#ef4444' : '#22c55e'}>
                {simNetGpm > 5 ? '▲' : simNetGpm < -5 ? '▼' : '●'} {simNetGpm > 0 ? '+' : ''}{simNetGpm.toFixed(0)} gpm net
              </text>
            </g>
          )}

          {/* Volume callouts */}
          {volSegments.map((seg, i) => {
            const yTop = toY(seg.to.elev);
            const yBot = toY(seg.from.elev);
            const pixH = yBot - yTop;
            if (pixH < 8) return null;
            const midY  = (yTop + yBot) / 2;
            const label = seg.gal >= 1000 ? `${(seg.gal / 1000).toFixed(2)}k gal` : `${seg.gal.toFixed(0)} gal`;
            return (
              <g key={i} style={{ pointerEvents: 'none' }}>
                <line x1={WELL_LEFT + 6} y1={yTop} x2={WELL_LEFT + 6} y2={yBot} stroke={seg.to.color} strokeWidth={1} opacity={0.3} />
                <line x1={WELL_LEFT + 3} y1={yTop} x2={WELL_LEFT + 10} y2={yTop} stroke={seg.to.color} strokeWidth={1} opacity={0.3} />
                <line x1={WELL_LEFT + 3} y1={yBot} x2={WELL_LEFT + 10} y2={yBot} stroke={seg.to.color} strokeWidth={1} opacity={0.3} />
                {pixH >= 16 && (
                  <text x={WELL_LEFT + 14} y={midY + 3} fill={seg.to.color} fontSize={8} opacity={0.8}>{label}</text>
                )}
              </g>
            );
          })}

          {/* Float-to-float dimension arrows */}
          {floats.length >= 2 && (() => {
            const sorted = [...floats].sort((a, b) => a.elevation - b.elevation);
            const xDim   = WELL_RIGHT - 14;
            return sorted.slice(0, -1).map((lower, i) => {
              const upper = sorted[i + 1];
              const yTop  = toY(upper.elevation);
              const yBot  = toY(lower.elevation);
              const pixH  = yBot - yTop;
              if (pixH < 10) return null;
              const midY = (yTop + yBot) / 2;
              const dist = (upper.elevation - lower.elevation).toFixed(2);
              return (
                <g key={`fdim-${i}`} style={{ pointerEvents: 'none' }}>
                  <line x1={WELL_RIGHT} y1={yTop} x2={xDim + 4} y2={yTop} stroke="#475569" strokeWidth={0.75} strokeDasharray="3,2" />
                  <line x1={WELL_RIGHT} y1={yBot} x2={xDim + 4} y2={yBot} stroke="#475569" strokeWidth={0.75} strokeDasharray="3,2" />
                  <line x1={xDim} y1={yTop} x2={xDim} y2={yBot} stroke="#94a3b8" strokeWidth={1.5} />
                  <polygon points={`${xDim},${yTop} ${xDim-3.5},${yTop+8} ${xDim+3.5},${yTop+8}`} fill="#94a3b8" />
                  <polygon points={`${xDim},${yBot} ${xDim-3.5},${yBot-8} ${xDim+3.5},${yBot-8}`} fill="#94a3b8" />
                  {pixH >= 20 && (
                    <>
                      <rect x={xDim - 20} y={midY - 9} width={40} height={16} rx={4} fill="#0a0f1e" opacity={0.9} />
                      <text x={xDim} y={midY + 4} textAnchor="middle" fill="#94a3b8" fontSize={10} fontWeight="700">{dist}′</text>
                    </>
                  )}
                </g>
              );
            });
          })()}

          {/* ALL PUMPS OFF level indicator — lowest float elevation */}
          {(() => {
            if (floats.length === 0) return null;
            const offFloat = floats.reduce((a, b) => a.elevation < b.elevation ? a : b);
            const y = toY(offFloat.elevation);
            return (
              <g style={{ pointerEvents: 'none' }}>
                {/* dashed line inside the well only */}
                <line x1={WELL_LEFT} x2={WELL_RIGHT} y1={y} y2={y}
                  stroke="#22c55e" strokeWidth={1} strokeDasharray="5,4" opacity={0.45} />
                <text x={WELL_LEFT + 4} y={y - 3} fill="#22c55e" fontSize={8} opacity={0.6} fontWeight="600">
                  ALL PUMPS OFF
                </text>
              </g>
            );
          })()}

          {/* Floats */}
          {simFloatStatus.map(f => {
            const fy  = toY(f.elevation);
            const fcx = WELL_RIGHT + 29;
            return (
              <g key={f.id}>
                {/* Wire from wall */}
                <line x1={WELL_RIGHT + 7} x2={WELL_RIGHT + 20} y1={fy} y2={fy}
                  stroke={f.color} strokeWidth={1.5} strokeDasharray="3,2" />

                {/* Dual staggered ripple rings — only when pump latched on */}
                {f.pumpOn && (
                  <>
                    <circle cx={fcx} cy={fy} fill="none"
                      stroke={f.color} strokeWidth={2.5}
                      className="float-ripple" />
                    <circle cx={fcx} cy={fy} fill="none"
                      stroke={f.color} strokeWidth={1.5}
                      className="float-ripple-2" />
                  </>
                )}

                {/* Float circle — pulses fill when pump running, static otherwise */}
                <circle cx={fcx} cy={fy} r={9}
                  fill={f.color} stroke="white"
                  className={f.pumpOn ? 'float-pulse' : undefined}
                  strokeWidth={f.pumpOn ? 2.5 : 1.5}
                  style={{ cursor: 'ns-resize' }}
                  onMouseDown={startDrag('float', f.id)} />

                <text x={WELL_RIGHT + 42} y={fy - 8}  fill={f.color} fontSize={10} fontWeight="bold">{f.name}</text>
                <text x={WELL_RIGHT + 42} y={fy + 4}  fill={f.color} fontSize={9}>{f.elevation.toFixed(2)}′</text>
                {/* Discharge label when pump ON */}
                {f.pumpOn && (
                  <text x={WELL_RIGHT + 42} y={fy + 16} fill={f.color} fontSize={8} fontWeight="700">⇒ {f.pumpDischarge} gpm out</text>
                )}
              </g>
            );
          })}

        </svg>

          {/* ── Scale grip — drag to resize diagram ── */}
          <div
            title={`Scale: ${svgScale.toFixed(1)}×  (drag to resize)`}
            onMouseDown={(e) => {
              e.preventDefault();
              dragging.current = { type: 'scale', startX: e.clientX, startY: e.clientY, startScale: svgScale };
            }}
            style={{ position: 'absolute', bottom: 0, right: 0, width: 24, height: 24, cursor: 'nwse-resize', zIndex: 10 }}
          >
            <svg width={24} height={24} style={{ display: 'block' }}>
              <polygon points="24,0 24,24 0,24" fill="#1e3a5f" opacity={0.9} />
              <line x1={20} y1={4}  x2={4}  y2={20} stroke="#38bdf8" strokeWidth={1.5} strokeLinecap="round" />
              <line x1={24} y1={10} x2={10} y2={24} stroke="#38bdf8" strokeWidth={1}   strokeLinecap="round" />
              <line x1={24} y1={17} x2={17} y2={24} stroke="#38bdf8" strokeWidth={1}   strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* ─── Simulation control bar ─── */}
        <div style={styles.simBar}>
          <button onClick={handleSimPlay} style={{
            ...styles.simBtn,
            background:  sim.isRunning ? '#450a0a' : '#052e16',
            borderColor: sim.isRunning ? '#ef4444' : '#22c55e',
            color:       sim.isRunning ? '#fca5a5' : '#86efac',
          }}>
            {sim.waterLevel === null ? '▶ SIMULATE' : sim.isRunning ? '⏸ PAUSE' : sim.completed ? '▶ RUN AGAIN' : '▶ RESUME'}
          </button>
          <button onClick={handleSimReset} style={{ ...styles.simBtn, background: '#1e293b', borderColor: '#334155', color: '#94a3b8' }}>
            ↺ RESET
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ color: '#475569', fontSize: 11 }}>Speed</span>
            <select value={sim.speedMultiplier}
              onChange={e => setSim(prev => ({ ...prev, speedMultiplier: +e.target.value }))}
              style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: 4, padding: '2px 6px', fontSize: 12 }}>
              {[1, 5, 10, 30, 60].map(s => <option key={s} value={s}>{s}×</option>)}
            </select>
          </div>
          {simActive && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ color: '#7dd3fc', fontSize: 12, fontFamily: 'monospace' }}>t = {fmtTime(sim.elapsedTime)}</span>
              <span style={{ color: '#38bdf8', fontSize: 12 }}>WL {sim.waterLevel?.toFixed(2)}′</span>
              <span style={{
                fontSize: 11,
                color: simNetGpm > 5 ? '#38bdf8' : simNetGpm < -5 ? '#ef4444' : '#22c55e',
              }}>
                {simNetGpm > 0 ? '+' : ''}{simNetGpm.toFixed(0)} gpm
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ═══ RIGHT: Data + Simulation ═══ */}
      <div style={styles.rightPanel}>
        <div style={styles.paneHeader}>ELEVATIONS &amp; DATA</div>

        {rightOrder.map((key, idx) => {
          const isFirst = idx === 0;
          const isLast  = idx === rightOrder.length - 1;
          const up   = isFirst ? null : () => moveSection(key, -1);
          const down = isLast  ? null : () => moveSection(key, +1);

          /* ── FLOATS ─────────────────────────────────────────────── */
          if (key === 'floats') return (
            <Section key={key} title="FLOATS" accent="#94a3b8"
              action={<Btn onClick={addFloat}>+ Float</Btn>}
              onMoveUp={up} onMoveDown={down}>
              {floats.map(f => (
                <div key={f.id} style={styles.itemBlock}>
                  <div style={styles.itemHeader}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: f.color, flexShrink: 0 }} />
                    <input value={f.name}
                      onChange={e => setFloats(prev => prev.map(x => x.id === f.id ? { ...x, name: e.target.value } : x))}
                      style={styles.textInput} />
                    <DelBtn onClick={() => removeFloat(f.id)} />
                  </div>
                  <div style={styles.itemBody}>
                    <span style={styles.lbl}>Elev</span>
                    <NumInput value={f.elevation}
                      min={wetWell.bottomElev} max={wetWell.bottomElev + wetWell.depth} step={0.01}
                      onChange={v => setFloats(prev => prev.map(x => x.id === f.id ? { ...x, elevation: v } : x))} />
                    <span style={styles.unit}>ft</span>
                    <input type="range"
                      min={wetWell.bottomElev} max={wetWell.bottomElev + wetWell.depth} step={0.05}
                      value={f.elevation}
                      onChange={e => setFloats(prev => prev.map(x => x.id === f.id ? { ...x, elevation: parseFloat(e.target.value) } : x))}
                      style={{ flex: 1, accentColor: f.color }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
                    <span style={{ fontSize: 10, color: '#ef4444', flexShrink: 0 }}>Pump Discharge</span>
                    <NumInput value={f.pumpDischarge} min={0} max={5000} step={10}
                      onChange={v => setFloats(prev => prev.map(x => x.id === f.id ? { ...x, pumpDischarge: v } : x))} />
                    <span style={styles.unit}>gpm</span>
                  </div>
                  {f.pumpDischarge > 0 && (
                    <div style={S.note}>Pump activates when WL ≥ {f.elevation.toFixed(2)}′</div>
                  )}
                </div>
              ))}
            </Section>
          );

          /* ── INLETS ─────────────────────────────────────────────── */
          if (key === 'inlets') return (
            <Section key={key} title="INLETS" accent="#60a5fa"
              action={<Btn onClick={addInlet}>+ Inlet</Btn>}
              onMoveUp={up} onMoveDown={down}>
              {inlets.map(i => (
                <div key={i.id} style={styles.itemBlock}>
                  <div style={styles.itemHeader}>
                    <span style={{ color: '#60a5fa', fontSize: 14, lineHeight: 1 }}>→</span>
                    <input value={i.name}
                      onChange={e => setInlets(prev => prev.map(x => x.id === i.id ? { ...x, name: e.target.value } : x))}
                      style={styles.textInput} />
                    <DelBtn onClick={() => removeInlet(i.id)} />
                  </div>
                  <div style={{ display: 'flex', gap: 10, paddingLeft: 18, flexWrap: 'wrap', marginBottom: 4 }}>
                    <div style={styles.itemBody}>
                      <span style={styles.lbl}>Invert</span>
                      <NumInput value={i.elevation}
                        min={wetWell.bottomElev} max={wetWell.bottomElev + wetWell.depth} step={0.01}
                        onChange={v => setInlets(prev => prev.map(x => x.id === i.id ? { ...x, elevation: v } : x))} />
                      <span style={styles.unit}>ft</span>
                    </div>
                    <div style={styles.itemBody}>
                      <span style={styles.lbl}>Dia</span>
                      <NumInput value={i.diameter} min={2} max={72} step={1}
                        onChange={v => setInlets(prev => prev.map(x => x.id === i.id ? { ...x, diameter: v } : x))} />
                      <span style={styles.unit}>in</span>
                    </div>
                  </div>
                  <div style={{ borderTop: '1px solid #1e293b', paddingTop: 6 }}>
                    <div style={{ fontSize: 10, color: '#38bdf8', fontWeight: 700, letterSpacing: 1, marginBottom: 5 }}>SIM FLOW</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <div style={styles.itemBody}>
                        <span style={styles.lbl}>Flow</span>
                        <NumInput value={i.flowRate} min={0} max={5000} step={10}
                          onChange={v => setInlets(prev => prev.map(x => x.id === i.id ? { ...x, flowRate: v } : x))} />
                        <span style={styles.unit}>gpm</span>
                      </div>
                      <div style={styles.itemBody}>
                        <span style={styles.lbl}>Start</span>
                        <NumInput value={+(i.startTime / 60).toFixed(2)} min={0} max={60} step={0.5}
                          onChange={v => setInlets(prev => prev.map(x => x.id === i.id ? { ...x, startTime: Math.round(v * 60) } : x))} />
                        <span style={styles.unit}>min</span>
                      </div>
                      <div style={styles.itemBody}>
                        <span style={styles.lbl}>Duration</span>
                        <NumInput value={+(i.duration / 60).toFixed(2)} min={0.1} max={60} step={0.5}
                          onChange={v => setInlets(prev => prev.map(x => x.id === i.id ? { ...x, duration: Math.max(1, Math.round(v * 60)) } : x))} />
                        <span style={styles.unit}>min</span>
                      </div>
                    </div>
                    <div style={S.note}>Active {fmtTime(i.startTime)} → {fmtTime(i.startTime + i.duration)}</div>
                  </div>
                </div>
              ))}
            </Section>
          );

          /* ── VOLUMES ─────────────────────────────────────────────── */
          if (key === 'volumes') return (
            <Section key={key} title="VOLUMES" accent="#22d3ee" onMoveUp={up} onMoveDown={down}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid #1e293b' }}>
                <span style={{ fontSize: 10, color: '#475569', fontWeight: 700 }}>SEGMENT</span>
                <div style={{ display: 'flex', gap: 20 }}>
                  <span style={{ fontSize: 10, color: '#475569', fontWeight: 700, width: 40, textAlign: 'right' }}>SPAN</span>
                  <span style={{ fontSize: 10, color: '#475569', fontWeight: 700, width: 64, textAlign: 'right' }}>VOLUME</span>
                </div>
              </div>
              {volSegments.map((seg, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, paddingBottom: 5, borderBottom: '1px solid #0f172a' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 0 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: seg.from.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 9, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{seg.from.label}</span>
                    <span style={{ fontSize: 9, color: '#334155' }}>→</span>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: seg.to.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 9, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{seg.to.label}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexShrink: 0, marginLeft: 6 }}>
                    <span style={{ fontSize: 11, color: '#475569', width: 40, textAlign: 'right' }}>{seg.height.toFixed(2)}′</span>
                    <span style={{ fontSize: 12, color: seg.to.color, fontWeight: 700, width: 64, textAlign: 'right' }}>
                      {seg.gal >= 1000 ? `${(seg.gal / 1000).toFixed(2)}k` : seg.gal.toFixed(0)} gal
                    </span>
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, paddingTop: 6, borderTop: '1px solid #334155' }}>
                <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>Total (floor → WL)</span>
                <span style={{ fontSize: 13, color: '#22d3ee', fontWeight: 700 }}>
                  {totalCurrentVol >= 1000 ? `${(totalCurrentVol / 1000).toFixed(2)}k` : totalCurrentVol.toFixed(0)} gal
                </span>
              </div>
            </Section>
          );

          /* ── SUMMARY ─────────────────────────────────────────────── */
          if (key === 'summary') return (
            <Section key={key} title="SUMMARY" accent="#a78bfa" onMoveUp={up} onMoveDown={down}>
              <SumRow label="Diameter / Area"  value={`${wetWell.width}′ Ø = ${wellArea.toFixed(1)} ft²`} />
              <SumRow label="Total Storage"    value={`${(wetWell.depth * wellArea * 7.48).toFixed(0)} gal`} />
              <SumRow label="Cycle Volume"     value={`${cycleVol.toFixed(0)} gal`}
                note={`${(onElev - offElev).toFixed(2)}′ drawdown · ON ${onElev.toFixed(2)}′ → OFF ${offElev.toFixed(2)}′`} />
              <SumRow label="Pump ON"          value={`${onElev.toFixed(2)} ft`} />
              <SumRow label="Pump OFF"         value={`${offElev.toFixed(2)} ft`} />
              <SumRow label="Pump Top Elev"
                value={`${(wetWell.bottomElev + pump.baseOffset + pump.height).toFixed(2)} ft`}
                note={`${pump.height.toFixed(1)}′ tall · base ${pump.baseOffset.toFixed(1)}′ off floor`} />
              {hwaElev !== undefined && <SumRow label="Hi-Water Alarm" value={`${hwaElev.toFixed(2)} ft`} />}
              {inlets.map(i => (
                <SumRow key={i.id} label={i.name} value={`Inv ${i.elevation.toFixed(2)} ft · ${i.diameter}″Ø`} />
              ))}
            </Section>
          );

          /* ── SIMULATION ──────────────────────────────────────────── */
          if (key === 'simulation' && simActive) return (
            <Section key={key} title="SIMULATION" accent="#f472b6" onMoveUp={up} onMoveDown={down}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
                {[
                  { label: 'TIME',    val: fmtTime(sim.elapsedTime),         color: '#f472b6' },
                  { label: 'WL',      val: `${sim.waterLevel?.toFixed(2)}′`, color: '#38bdf8' },
                  { label: 'INFLOW',  val: `${simTotalIn.toFixed(0)} gpm`,   color: '#38bdf8' },
                  { label: 'OUTFLOW', val: `${simTotalOut} gpm`,             color: '#ef4444' },
                  { label: 'NET',
                    val: `${simNetGpm > 0 ? '+' : ''}${simNetGpm.toFixed(0)} gpm`,
                    color: simNetGpm > 5 ? '#38bdf8' : simNetGpm < -5 ? '#ef4444' : '#22c55e' },
                  { label: 'ACTIVE PUMPS',
                    val: `${simFloatStatus.filter(f => f.pumpOn).length} / ${floats.filter(f => f.pumpDischarge > 0).length}`,
                    color: '#f97316' },
                  { label: 'TOTAL VOL IN',
                    val: (() => { const g = sim.cumulativeGalIn ?? 0; return g >= 1000 ? `${(g/1000).toFixed(2)}k gal` : `${g.toFixed(0)} gal`; })(),
                    color: '#22d3ee' },
                ].map(({ label, val, color }) => (
                  <div key={label} style={{ background: '#0d1a2d', borderRadius: 5, padding: '5px 8px' }}>
                    <div style={{ fontSize: 9, color: '#475569', fontWeight: 700 }}>{label}</div>
                    <div style={{ fontSize: 13, color, fontWeight: 700, fontFamily: 'monospace' }}>{val}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>INLET TIMELINE</div>
              {(() => {
                const ganttH = inlets.length * 22 + 20;
                const W = 260;
                const barW = W;
                return (
                  <svg viewBox={`0 0 ${W} ${ganttH}`} width="100%" height={ganttH} style={{ display: 'block', marginBottom: 8 }}>
                    {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                      const x = frac * (barW - 2) + 1;
                      return (
                        <g key={frac}>
                          <line x1={x} y1={0} x2={x} y2={inlets.length * 22 + 2} stroke="#1e293b" strokeWidth={1} />
                          <text x={x} y={ganttH - 3}
                            textAnchor={frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle'}
                            fill="#334155" fontSize={7}>
                            {fmtTime(frac * simMaxTime)}
                          </text>
                        </g>
                      );
                    })}
                    {(() => {
                      const px = Math.min(1, sim.elapsedTime / simMaxTime) * (barW - 2) + 1;
                      return <line x1={px} y1={0} x2={px} y2={inlets.length * 22 + 2} stroke="#f472b6" strokeWidth={1.5} />;
                    })()}
                    {inlets.map((inlet, idx) => {
                      const bx = (inlet.startTime / simMaxTime) * (barW - 2) + 1;
                      const bw = Math.max(2, (inlet.duration / simMaxTime) * (barW - 2));
                      const by = idx * 22 + 2;
                      const on = sim.elapsedTime >= inlet.startTime && sim.elapsedTime < inlet.startTime + inlet.duration;
                      return (
                        <g key={inlet.id}>
                          <rect x={bx} y={by} width={bw} height={16} fill="#1d4ed8" rx={2} opacity={0.7} />
                          {on && <rect x={bx} y={by} width={bw} height={16} fill="#38bdf8" rx={2} opacity={0.3} />}
                          <text x={bx + 3} y={by + 11} fill="#93c5fd" fontSize={8} fontWeight="bold">
                            {inlet.name} · {inlet.flowRate}gpm
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                );
              })()}

              {sim.flowHistory.length > 1 && (() => {
                const cH = 72; const cW = 260; const pad = 4;
                const hist = sim.flowHistory;
                const maxT = Math.max(hist[hist.length - 1].t, 1);
                const minWL2 = wetWell.bottomElev;
                const wlRange = wetWell.depth || 1;
                const toChartX = (t) => pad + (t / maxT) * (cW - pad * 2);
                const toChartY = (wl) => cH - pad - ((wl - minWL2) / wlRange) * (cH - pad * 2);
                const pts = hist.map(p => `${toChartX(p.t)},${toChartY(p.wl)}`).join(' ');
                return (
                  <>
                    <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>WATER LEVEL HISTORY</div>
                    <svg viewBox={`0 0 ${cW} ${cH}`} width="100%" height={cH}
                      style={{ display: 'block', background: '#0d1a2d', borderRadius: 4, border: '1px solid #1e293b', marginBottom: 8 }}>
                      {floats.filter(f => f.elevation >= minWL2 && f.elevation <= minWL2 + wlRange).map(f => (
                        <line key={f.id}
                          x1={pad} y1={toChartY(f.elevation)} x2={cW - pad} y2={toChartY(f.elevation)}
                          stroke={f.color} strokeWidth={0.75} opacity={0.45} strokeDasharray="4,3" />
                      ))}
                      <polyline points={pts} fill="none" stroke="#38bdf8" strokeWidth={2} />
                    </svg>
                  </>
                );
              })()}

              {sim.events.length > 0 && (
                <>
                  <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>EVENTS</div>
                  <div style={{ maxHeight: 150, overflowY: 'auto', fontSize: 10 }}>
                    {[...sim.events].reverse().map((ev, i) => (
                      <div key={i} style={{ display: 'flex', gap: 7, padding: '3px 0', borderBottom: '1px solid #0f172a' }}>
                        <span style={{ color: '#334155', fontFamily: 'monospace', flexShrink: 0, minWidth: 34 }}>{fmtTime(ev.t)}</span>
                        <span style={{ color: ev.type === 'pump' ? '#f97316' : ev.type === 'warn' ? '#ef4444' : '#38bdf8' }}>
                          {ev.msg}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Section>
          );

          return null;
        })}

      </div>
    </div>
  );
}

// ─── Tiny sub-components ─────────────────────────────────────────────────────

function Section({ title, children, action, accent = '#7dd3fc', onMoveUp, onMoveDown }) {
  const arrowBtn = (handler, symbol) => (
    <button
      onClick={handler}
      disabled={!handler}
      style={{
        background: 'none', border: 'none',
        color: handler ? '#64748b' : '#1e293b',
        cursor: handler ? 'pointer' : 'default',
        padding: '0 3px', fontSize: 10, lineHeight: 1,
        transition: 'color 0.15s',
      }}
      onMouseEnter={e => { if (handler) e.currentTarget.style.color = '#94a3b8'; }}
      onMouseLeave={e => { if (handler) e.currentTarget.style.color = '#64748b'; }}
    >{symbol}</button>
  );
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <span style={{ ...styles.sectionTitle, color: accent }}>{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {action}
          <div style={{ display: 'flex', gap: 0, marginLeft: action ? 4 : 0 }}>
            {arrowBtn(onMoveUp,   '▲')}
            {arrowBtn(onMoveDown, '▼')}
          </div>
        </div>
      </div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={styles.row}>
      <span style={styles.lbl}>{label}</span>
      {children}
    </div>
  );
}

// Small helpers to avoid inline style verbosity
function Pair({ children }) { return <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{children}</div>; }
function U({ children })    { return <span style={styles.unit}>{children}</span>; }

function NumInput({ value, min, max, step, onChange }) {
  return (
    <input type="number" value={value} min={min} max={max} step={step}
      onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
      style={styles.numInput} />
  );
}

function Btn({ onClick, children }) {
  return <button onClick={onClick} style={styles.addBtn}>{children}</button>;
}

function DelBtn({ onClick }) {
  return <button onClick={onClick} style={styles.delBtn}>✕</button>;
}

function SumRow({ label, value, note }) {
  return (
    <div style={styles.sumRow}>
      <span style={styles.lbl}>{label}</span>
      <div style={{ textAlign: 'right' }}>
        <span style={styles.sumVal}>{value}</span>
        {note && <div style={styles.sumNote}>{note}</div>}
      </div>
    </div>
  );
}

// Shared inline-style snippets (not in styles object since they're tiny one-offs)
const S = {
  note: { fontSize: 10, color: '#475569', marginTop: 2 },
};

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = {
  root: {
    display: 'flex',
    minHeight: '100vh',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    background: '#0a0f1e',
    color: '#e2e8f0',
    overflow: 'auto',
  },
  leftPanel: {
    width: 250,
    flexShrink: 0,
    overflowY: 'auto',
    padding: 12,
    borderRight: '1px solid #1e293b',
    background: '#0a0f1e',
  },
  svgPane: {
    flexShrink: 0,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    borderRight: '1px solid #1e293b',
    overflowY: 'auto',
  },
  rightPanel: {
    width: 310,
    flexShrink: 0,
    overflowY: 'auto',
    padding: 12,
    background: '#0a0f1e',
  },
  panel: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    minWidth: 280,
    maxWidth: 420,
  },
  paneHeader: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 2,
    color: '#7dd3fc',
    paddingBottom: 4,
  },
  svg: {
    background: '#0d1a2d',
    borderRadius: 8,
    border: '1px solid #1e3a5f',
    userSelect: 'none',
    display: 'block',
  },
  simBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 2px 2px',
    borderTop: '1px solid #1e293b',
    flexWrap: 'wrap',
  },
  simBtn: {
    padding: '5px 12px',
    border: '1px solid',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: 0.5,
  },
  section: {
    marginBottom: 12,
    background: '#111827',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid #1e293b',
  },
  sectionHeader: {
    padding: '6px 10px',
    background: '#1e293b',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1.5,
  },
  sectionBody: {
    padding: '8px 10px',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 7,
  },
  lbl: {
    fontSize: 11,
    color: '#94a3b8',
    flexShrink: 0,
  },
  unit: {
    fontSize: 11,
    color: '#475569',
    flexShrink: 0,
  },
  numInput: {
    width: 82,
    background: '#0a0f1e',
    border: '1px solid #334155',
    borderRadius: 4,
    color: '#e2e8f0',
    padding: '3px 7px',
    fontSize: 13,
    textAlign: 'right',
  },
  textInput: {
    flex: 1,
    background: '#0a0f1e',
    border: '1px solid #334155',
    borderRadius: 4,
    color: '#e2e8f0',
    padding: '3px 6px',
    fontSize: 12,
  },
  addBtn: {
    background: '#1e3a8a',
    color: '#bfdbfe',
    border: 'none',
    borderRadius: 4,
    padding: '3px 9px',
    fontSize: 11,
    cursor: 'pointer',
    fontWeight: 600,
  },
  delBtn: {
    background: 'none',
    border: 'none',
    color: '#ef4444',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 3px',
    lineHeight: 1,
  },
  itemBlock: {
    marginBottom: 10,
    paddingBottom: 10,
    borderBottom: '1px solid #1e293b',
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 5,
  },
  itemBody: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    flex: 1,
  },
  sumRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
    paddingBottom: 6,
    borderBottom: '1px solid #1e293b',
  },
  sumVal: {
    fontSize: 13,
    color: '#e2e8f0',
    fontWeight: 600,
  },
  sumNote: {
    fontSize: 10,
    color: '#64748b',
    marginTop: 1,
  },
};
