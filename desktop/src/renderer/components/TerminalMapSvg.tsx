import { useRef, useMemo, type CSSProperties } from "react";
import {
  useSvgFlowAnimations,
  useVesselGsapTransforms,
  useWaterwayWaves,
} from "../hooks/useSimulationGsap";
import {
  getVesselVisual,
  type SimCustomer,
  type SimResource,
  type SimSlot,
  type SimConfig,
} from "../hooks/useSimulationData";

/* ── ViewBox & layout ── */

const VB_W = 1200;
const VB_H = 700;
const MARGIN = 32;

const BP_BLUE = "#0047AB";
const STROKE = "#ffffff";
const STROKE_DIM = "rgba(255,255,255,0.45)";
const STROKE_SOFT = "rgba(255,255,255,0.35)";
const STROKE_MUTED = "rgba(255,255,255,0.5)";
const CAPACITY_STROKE = "#dc2626";
/** Longer gap so capacity reads clearly as dotted at schematic scale. */
const CAPACITY_DASH = "8 6";
const BORROW_STROKE = "#fbbf24";
const BORROW_DASH = "6 5";
const OVERLAY_GREY = "rgba(30,30,40,0.15)";
/** Primary blueprint stroke */
const SW = 0.9;
/** Deck detail, inner rings, secondary geometry */
const SW_HAIR = 0.65;

const PIPE_Y = 24;

const TF_TOP = 52;
const TF_BOT = 340;
const TF_PAD = 14;
const TF_TITLE_H = 28;
const STOCK_W = 260;
const TANKS_PER_ROW = 6;

const QUAY_Y = 500;
const DOCK_Y = QUAY_Y + 36;
const FAR_WATER_Y = VB_H - 20;
const BERTH_HALF_BEAM = 16;
const RAIL_Y = QUAY_Y - 68;

/** Must match `VesselShape` tanker scale — deck connection in local coords (bow +x, quay toward −y). */
const SHIP_SCALE = 1.24;
const SHIP_DECK_CONN_LOCAL_X = -1.2;
/** Local hull top (same units as path before scale) — quay arm lands at manifold height on deck */
const SHIP_DECK_CONN_LOCAL_Y = -10;

const FLOW_COLOR = "rgba(255,255,255,0.7)";

const LBL: CSSProperties = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 12,
  fontWeight: 500,
  fill: "#ffffff",
  letterSpacing: "0.5px",
};
const LBL_SM: CSSProperties = {
  ...LBL,
  fontSize: 10,
  fontWeight: 500,
  fill: "rgba(255,255,255,0.85)",
};
const LBL_LEGEND: CSSProperties = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 8,
  fontWeight: 400,
  fill: "rgba(255,255,255,0.75)",
  letterSpacing: "0.5px",
};
const CHIP_TEXT: CSSProperties = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 11,
  fontWeight: 500,
  fill: "#ffffff",
  letterSpacing: "0.5px",
};
const DIM_TEXT: CSSProperties = {
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 8,
  fontWeight: 400,
  fill: "rgba(255,255,255,0.65)",
  letterSpacing: "0.5px",
};

const RIPPLE_SEEDS: [number, number][] = [
  [0.08, 0.15], [0.18, 0.45], [0.28, 0.25], [0.38, 0.65],
  [0.48, 0.35], [0.58, 0.55], [0.68, 0.2], [0.78, 0.7],
  [0.88, 0.4], [0.15, 0.8], [0.45, 0.85], [0.72, 0.85],
  [0.92, 0.15], [0.32, 0.5], [0.62, 0.75],
];

const BERTH_LATERAL_SWING = 46;

const BERTH_RISER_TOP = TF_BOT + 28;

/* ── Zone labels (text only) ── */

function ZoneChipLabel({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <text x={x + 8} y={y + 15} style={CHIP_TEXT}>
      {label}
    </text>
  );
}

/** Storage tank: double outer ring, mid ring, hub, radial tick (~2 o'clock), side nub — blueprint, no fill. */
function TankBlueprintDetail({
  cx,
  cy,
  r,
  surfaceY,
  invRatio,
  borrowLimitY,
}: {
  cx: number;
  cy: number;
  r: number;
  surfaceY: number;
  invRatio: number;
  borrowLimitY?: number;
}) {
  const tickA = (-60 * Math.PI) / 180;
  const cosT = Math.cos(tickA);
  const sinT = Math.sin(tickA);
  const rMid = r * 0.52;
  const rTickOuter = Math.max(r - 1.8, rMid + 1.5);
  const rHub = Math.max(2.8, r * 0.2);

  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={STROKE} strokeWidth={SW} />
      <circle cx={cx} cy={cy} r={Math.max(r - 1.05, rHub + 1.2)} fill="none" stroke={STROKE_DIM} strokeWidth={SW_HAIR} />
      <circle cx={cx} cy={cy} r={r * 0.54} fill="none" stroke={STROKE_DIM} strokeWidth={SW_HAIR} />
      <circle cx={cx} cy={cy} r={rHub} fill="none" stroke={STROKE_DIM} strokeWidth={SW_HAIR} />
      <line
        x1={cx + rMid * cosT}
        y1={cy + rMid * sinT}
        x2={cx + rTickOuter * cosT}
        y2={cy + rTickOuter * sinT}
        stroke={STROKE_DIM}
        strokeWidth={SW_HAIR}
        strokeLinecap="round"
      />
      <rect
        x={cx + r + 0.35}
        y={cy - 2}
        width={4.2}
        height={4}
        rx={0.45}
        fill="none"
        stroke={STROKE_DIM}
        strokeWidth={SW_HAIR}
      />
      {invRatio > 0.005 && (
        <line
          x1={cx - r + 4}
          y1={surfaceY}
          x2={cx + r - 4}
          y2={surfaceY}
          stroke={STROKE}
          strokeWidth={SW_HAIR}
          strokeDasharray="3 2"
          strokeLinecap="butt"
          opacity={0.85}
        />
      )}
      {invRatio < -0.005 && (
        <line
          x1={cx - r + 4}
          y1={surfaceY}
          x2={cx + r - 4}
          y2={surfaceY}
          stroke={BORROW_STROKE}
          strokeWidth={SW_HAIR}
          strokeDasharray="3 2"
          strokeLinecap="butt"
          opacity={0.85}
        />
      )}
      <line
        x1={cx - r + 5}
        y1={cy - r}
        x2={cx + r - 5}
        y2={cy - r}
        stroke={CAPACITY_STROKE}
        strokeWidth={SW_HAIR}
        strokeDasharray={CAPACITY_DASH}
        strokeLinecap="butt"
        opacity={0.95}
      >
        <title>Tank capacity (100%)</title>
      </line>
      {borrowLimitY != null && (
        <line
          x1={cx - r + 5}
          y1={borrowLimitY}
          x2={cx + r - 5}
          y2={borrowLimitY}
          stroke={BORROW_STROKE}
          strokeWidth={SW_HAIR}
          strokeDasharray={BORROW_DASH}
          strokeLinecap="butt"
          opacity={0.95}
        >
          <title>Max borrowing limit (attributed deficit floor)</title>
        </line>
      )}
    </g>
  );
}

/* ── Vessels: wireframe + customer fill dots only ── */

function VesselShape({ mode, color }: { mode: string; color: string }) {
  if (mode === "train") {
    const wagon = (dx: number, k: string) => (
      <g key={k} transform={`translate(${dx},0)`}>
        <rect
          x={-16}
          y={-7}
          width={32}
          height={14}
          rx={3}
          fill="none"
          stroke={STROKE}
          strokeWidth={SW_HAIR}
        />
        <circle cx={0} cy={0} r={3} fill={color} stroke={STROKE} strokeWidth={SW_HAIR} />
      </g>
    );
    return (
      <g>
        {wagon(-36, "a")}
        {wagon(0, "b")}
        {wagon(36, "c")}
      </g>
    );
  }

  if (mode === "barge") {
    return (
      <g>
        <rect
          x={-28}
          y={-10}
          width={56}
          height={20}
          rx={5}
          fill="none"
          stroke={STROKE}
          strokeWidth={SW_HAIR}
        />
        <rect
          x={14}
          y={-6}
          width={11}
          height={10}
          rx={2}
          fill="none"
          stroke={STROKE_DIM}
          strokeWidth={SW_HAIR}
        />
        <circle cx={-6} cy={0} r={4.5} fill={color} stroke="#fff" strokeWidth={SW_HAIR} />
      </g>
    );
  }

  /** Tanker: pronounced squared-off stern (wide transom at −42, r=4 quarters); rounded bow (+x). */
  const hullD =
    "M -38 -10 A 4 4 0 0 0 -42 -6 L -42 6 A 4 4 0 0 0 -38 10 L 13 10 L 15.5 10 L 32 10 Q 36.5 10 37.5 0 Q 36.5 -10 32 -10 L 15.5 -10 L 13 -10 L -38 -10 Z";

  return (
    <g transform={`scale(${SHIP_SCALE})`}>
      <path
        d={hullD}
        fill="none"
        stroke={STROKE}
        strokeWidth={SW}
        strokeLinejoin="round"
        vectorEffect="nonScalingStroke"
      />
      {/* Stern deckhouse */}
      <rect
        x={-40}
        y={-7}
        width={11}
        height={14}
        rx={1.2}
        fill="none"
        stroke={STROKE_DIM}
        strokeWidth={SW_HAIR}
        vectorEffect="nonScalingStroke"
      />
      <circle cx={-34.5} cy={0} r={2.2} fill={color} stroke={STROKE} strokeWidth={SW_HAIR} vectorEffect="nonScalingStroke" />
      {/* Main deck trunk — quay loading arm only while at berth (pump) */}
      <line
        x1={-31}
        y1={0}
        x2={11}
        y2={0}
        stroke={STROKE_DIM}
        strokeWidth={SW_HAIR}
        strokeLinecap="round"
        vectorEffect="nonScalingStroke"
      />
      {/* Cargo tank outlines on deck */}
      <circle cx={-12} cy={0} r={6.2} fill="none" stroke={STROKE_DIM} strokeWidth={SW_HAIR} vectorEffect="nonScalingStroke" />
      <circle cx={6} cy={0} r={6.2} fill="none" stroke={STROKE_DIM} strokeWidth={SW_HAIR} vectorEffect="nonScalingStroke" />
      <circle cx={-12} cy={0} r={3} fill={color} stroke={STROKE} strokeWidth={SW_HAIR} vectorEffect="nonScalingStroke" />
      <circle cx={6} cy={0} r={3} fill={color} stroke={STROKE} strokeWidth={SW_HAIR} vectorEffect="nonScalingStroke" />
      {/* Manifold on trunk (quay arm meets deck here) */}
      <circle cx={-1.2} cy={0} r={2.2} fill="none" stroke={STROKE} strokeWidth={SW_HAIR} vectorEffect="nonScalingStroke" />
      {/* Bow marker — sits on rounded nose */}
      <circle cx={30} cy={0} r={2.6} fill={color} stroke={STROKE} strokeWidth={SW_HAIR} vectorEffect="nonScalingStroke" />
    </g>
  );
}

/* ── Vessel motion helpers ── */

function berthVesselY(phase: string, legT: number): number {
  if (phase === "approach") return FAR_WATER_Y - legT * (FAR_WATER_Y - DOCK_Y);
  if (phase === "pump") return DOCK_Y;
  if (phase === "depart") return DOCK_Y + legT * (FAR_WATER_Y - DOCK_Y);
  return FAR_WATER_Y;
}

function berthVesselX(phase: string, legT: number, laneX: number): number {
  if (phase === "approach") return laneX + BERTH_LATERAL_SWING * Math.cos((legT * Math.PI) / 2);
  if (phase === "depart") return laneX - BERTH_LATERAL_SWING * Math.sin((legT * Math.PI) / 2);
  return laneX;
}

function railVesselX(
  phase: string,
  legT: number,
  inbound: boolean,
  dockX: number,
  farR: number,
  farL: number,
): number {
  if (phase === "idle") return inbound ? farR : farL;
  if (phase === "approach") return inbound ? farR - legT * (farR - dockX) : farL + legT * (dockX - farL);
  if (phase === "pump") return dockX;
  if (phase === "depart") return inbound ? dockX + legT * (farR - dockX) : dockX - legT * (dockX - farL);
  return dockX;
}

/* ── Props ── */

export interface TerminalMapProps {
  customers: SimCustomer[];
  resourceRows: SimResource[];
  slots: SimSlot[];
  config: SimConfig | null;
  currentHour: number;
  isPlaying: boolean;
  effectiveSpeed: number;
  flowAnimOn: boolean;
  pipeRate: number;
  pipeInbound: boolean;
  tankCount: number;
  totalCapacity: number;
  getInventoryAtHour: (id: string, hour: number) => number;
  customerColor: (id: string) => string;
  customerById: Map<string, SimCustomer>;
}

/* ── Main component ── */

export default function TerminalMapSvg(props: TerminalMapProps) {
  const {
    customers,
    resourceRows,
    slots,
    config,
    currentHour,
    isPlaying,
    effectiveSpeed,
    flowAnimOn,
    pipeRate,
    pipeInbound,
    tankCount,
    totalCapacity,
    getInventoryAtHour,
    customerColor,
    customerById,
  } = props;

  const svgRef = useRef<SVGSVGElement>(null);
  const simStartMs = config?.startDate ? new Date(config.startDate).getTime() : 0;
  const preOH = config?.preOpsHours ?? 0;
  const postOH = config?.postOpsHours ?? 0;

  const tankLayout = useMemo(() => {
    const titleBand = TF_PAD + TF_TITLE_H + 8;
    const x0 = MARGIN + TF_PAD;
    const x1 = VB_W - MARGIN - STOCK_W - TF_PAD;
    const y0 = TF_TOP + titleBand;
    const y1 = TF_BOT - 12;
    const rowCount = Math.ceil(tankCount / TANKS_PER_ROW);
    const cellH = (y1 - y0) / Math.max(rowCount, 1);
    const centers: { cx: number; cy: number; r: number; i: number }[] = [];
    let idx = 0;
    for (let row = 0; row < rowCount; row++) {
      const start = row * TANKS_PER_ROW;
      const end = Math.min(start + TANKS_PER_ROW, tankCount);
      const nInRow = end - start;
      const cellW = (x1 - x0) / nInRow;
      const cy = y0 + (row + 0.5) * cellH;
      const rTank = Math.min(56, cellW / 2 - 3, cellH / 2 - 3);
      for (let j = 0; j < nInRow; j++) {
        centers.push({ cx: x0 + (j + 0.5) * cellW, cy, r: rTank, i: idx++ });
      }
    }
    return { centers, x0, x1, y0, y1 };
  }, [tankCount]);

  const berthResources = useMemo(
    () => resourceRows.filter((r) => r.type.startsWith("berth")),
    [resourceRows],
  );

  const laneXs = useMemo(() => {
    const nB = berthResources.length;
    const spacing = nB > 1 ? Math.min(200, (VB_W - 2 * MARGIN - 200) / (nB - 1)) : 0;
    const startX = (VB_W - (nB - 1) * spacing) / 2;
    return resourceRows.map((r) => {
      if (r.type === "rail_siding") return VB_W - MARGIN - 100;
      const bi = berthResources.findIndex((b) => b.id === r.id);
      return bi < 0 ? VB_W / 2 : startX + bi * spacing;
    });
  }, [resourceRows, berthResources]);

  const railXEnd = MARGIN + (VB_W - 2 * MARGIN) * 0.35;
  const railXStart = VB_W - MARGIN - 14;
  const RAIL_DOCK_X = railXEnd + 38;
  const FAR_RAIL_R = railXStart + 160;
  const FAR_RAIL_L = railXEnd - 100;

  const slotByResource = useMemo(() => {
    const map = new Map<string, SimSlot>();
    if (!config?.startDate) return map;
    for (const resource of resourceRows) {
      const slot = slots.find(
        (s) =>
          s.resourceId === resource.id &&
          getVesselVisual(s, resource, simStartMs, currentHour, preOH, postOH).phase !== "idle",
      );
      if (slot) map.set(resource.id, slot);
    }
    return map;
  }, [slots, resourceRows, config, simStartMs, currentHour, preOH, postOH]);

  const vesselTargets = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < resourceRows.length; i++) {
      const res = resourceRows[i];
      const slot = slotByResource.get(res.id);
      if (!slot) continue;
      const vis = getVesselVisual(slot, res, simStartMs, currentHour, preOH, postOH);
      if (vis.phase === "idle") continue;
      if (res.type === "rail_siding") {
        m.set(slot.id, {
          x: railVesselX(vis.phase, vis.legT, slot.direction === "inbound", RAIL_DOCK_X, FAR_RAIL_R, FAR_RAIL_L),
          y: RAIL_Y,
        });
      } else {
        m.set(slot.id, {
          x: berthVesselX(vis.phase, vis.legT, laneXs[i] ?? VB_W / 2),
          y: berthVesselY(vis.phase, vis.legT),
        });
      }
    }
    return m;
  }, [resourceRows, slotByResource, simStartMs, currentHour, preOH, postOH, laneXs, RAIL_DOCK_X, FAR_RAIL_R, FAR_RAIL_L]);

  useSvgFlowAnimations(svgRef, flowAnimOn, pipeRate, pipeInbound);
  useVesselGsapTransforms(svgRef, vesselTargets, isPlaying, effectiveSpeed);
  useWaterwayWaves(svgRef, isPlaying);

  const commingleStack = useMemo(() => {
    const parts = customers
      .filter((c) => c.id)
      .map((c) => ({ id: c.id, color: customerColor(c.id), vol: getInventoryAtHour(c.id, currentHour) }))
      .filter((p) => p.vol !== 0);
    const totalInv = customers
      .filter((c) => c.id)
      .reduce((s, c) => s + getInventoryAtHour(c.id, currentHour), 0);
    return { parts, totalInv, totalCap: totalCapacity };
  }, [customers, getInventoryAtHour, currentHour, customerColor, totalCapacity]);

  const storageMode = config?.storageMode ?? "fixed_band";
  const borrowLimitTonnes =
    storageMode === "shared_inventory"
      ? Math.max(0, config?.sharedInventoryCustomerDeficitLimitTonnes ?? 0)
      : 0;

  const invRatio =
    commingleStack.totalCap > 0 ? commingleStack.totalInv / commingleStack.totalCap : 0;

  const invLevelY = (cy: number, r: number, tonnes: number) =>
    cy + r - (2 * r * tonnes) / Math.max(commingleStack.totalCap, 1);

  const trunkX =
    tankLayout.centers.length >= 2
      ? (tankLayout.centers[0].cx + tankLayout.centers[1].cx) / 2
      : tankLayout.centers[0]?.cx ?? VB_W / 2;

  /** Shared manifold below tank circles, feeding berth risers */
  const manifoldY = useMemo(() => {
    if (!tankLayout.centers.length) return TF_BOT - 24;
    const maxBottom = Math.max(...tankLayout.centers.map((t) => t.cy + t.r));
    return Math.min(Math.max(maxBottom + 12, TF_TOP + 36), TF_BOT - 4);
  }, [tankLayout]);

  const berthLaneXs = useMemo(
    () =>
      resourceRows
        .map((r, i) => (r.type.startsWith("berth") ? laneXs[i] : null))
        .filter((x): x is number => x != null),
    [resourceRows, laneXs],
  );

  const hasRail = resourceRows.some((r) => r.type === "rail_siding");

  const manifoldSpan = useMemo(() => {
    const xs = [trunkX, ...tankLayout.centers.map((t) => t.cx), ...berthLaneXs];
    if (hasRail) xs.push(RAIL_DOCK_X);
    if (xs.length === 0) return { x1: MARGIN + 20, x2: VB_W - MARGIN - 20 };
    return {
      x1: Math.max(MARGIN + 8, Math.min(...xs) - 24),
      x2: Math.min(VB_W - MARGIN - 8, Math.max(...xs) + 24),
    };
  }, [trunkX, tankLayout.centers, berthLaneXs, hasRail, RAIL_DOCK_X]);

  const railBranchPath = useMemo(() => {
    if (!hasRail) return "";
    const yMid = (manifoldY + RAIL_Y) / 2;
    return `M ${trunkX} ${manifoldY} L ${trunkX} ${yMid} L ${RAIL_DOCK_X} ${yMid} L ${RAIL_DOCK_X} ${RAIL_Y - 8}`;
  }, [hasRail, trunkX, manifoldY, RAIL_DOCK_X, RAIL_Y]);

  const railResource = useMemo(() => resourceRows.find((r) => r.type === "rail_siding"), [resourceRows]);

  const railSlotActive = useMemo(() => {
    if (!railResource || !config?.startDate) return false;
    const slot = slotByResource.get(railResource.id);
    if (!slot) return false;
    return getVesselVisual(slot, railResource, simStartMs, currentHour, preOH, postOH).phase !== "idle";
  }, [railResource, slotByResource, config, simStartMs, currentHour, preOH, postOH]);

  const railFlowBerthAttr = useMemo((): "to-ship" | "to-tanks" => {
    if (!railResource) return "to-tanks";
    const s = slotByResource.get(railResource.id);
    return s?.direction === "inbound" ? "to-tanks" : "to-ship";
  }, [railResource, slotByResource]);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Terminal blueprint overview"
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      <rect width={VB_W} height={VB_H} fill={BP_BLUE} />
      <rect width={VB_W} height={VB_H} fill={OVERLAY_GREY} />

      <g shapeRendering="geometricPrecision">
        {/* Land / water separator — faint dashed guide */}
        <line
          x1={MARGIN}
          y1={QUAY_Y}
          x2={VB_W - MARGIN}
          y2={QUAY_Y}
          stroke={STROKE_SOFT}
          strokeWidth={1}
          strokeDasharray="6 6"
          opacity={0.35}
        />

        {/* Water ripples */}
        {RIPPLE_SEEDS.map(([u, v], i) => (
          <g
            key={`rip${i}`}
            transform={`translate(${(MARGIN + u * (VB_W - 2 * MARGIN)).toFixed(1)},${(QUAY_Y + 16 + v * (VB_H - QUAY_Y - 36)).toFixed(1)}) rotate(${-8 + ((i * 17) % 23)})`}
          >
            <g data-water-glyph-wrap="">
              <path
                d="M -15 3 L 0 6 L 15 3"
                fill="none"
                stroke={STROKE_SOFT}
                strokeWidth={SW_HAIR}
                strokeLinecap="round"
                opacity={0.55}
              />
            </g>
          </g>
        ))}

        {/* Pipeline */}
        <line x1={0} y1={PIPE_Y} x2={VB_W} y2={PIPE_Y} stroke={STROKE} strokeWidth={SW} strokeLinecap="round" />
        {flowAnimOn && (
          <line
            x1={0}
            y1={PIPE_Y}
            x2={VB_W}
            y2={PIPE_Y}
            stroke={FLOW_COLOR}
            strokeWidth={SW}
            strokeDasharray="7 9"
            opacity={0.65}
            data-sim-flow="h"
            data-berth-flow={pipeInbound ? "to-tanks" : "to-ship"}
          />
        )}

        {/* Tank Farm zone */}
        <rect
          x={MARGIN}
          y={TF_TOP}
          width={VB_W - 2 * MARGIN}
          height={TF_BOT - TF_TOP}
          rx={10}
          fill="none"
          stroke={STROKE_MUTED}
          strokeWidth={SW}
          strokeDasharray="8 4"
        />
        {/* Inlet trunk: pipeline header into tank farm down to manifold */}
        <line
          x1={trunkX}
          y1={PIPE_Y + 4}
          x2={trunkX}
          y2={manifoldY}
          stroke={STROKE}
          strokeWidth={SW}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {flowAnimOn && (
          <line
            x1={trunkX}
            y1={PIPE_Y + 4}
            x2={trunkX}
            y2={manifoldY}
            stroke={FLOW_COLOR}
            strokeWidth={SW}
            strokeDasharray="7 9"
            opacity={0.65}
            data-sim-flow="v"
            data-berth-flow={pipeInbound ? "to-tanks" : "to-ship"}
          />
        )}

        {/* Horizontal manifold tying tanks and berth drops */}
        <line
          x1={manifoldSpan.x1}
          y1={manifoldY}
          x2={manifoldSpan.x2}
          y2={manifoldY}
          stroke={STROKE}
          strokeWidth={SW}
          strokeLinecap="round"
        />
        {flowAnimOn && (
          <line
            x1={manifoldSpan.x1}
            y1={manifoldY}
            x2={manifoldSpan.x2}
            y2={manifoldY}
            stroke={FLOW_COLOR}
            strokeWidth={SW}
            strokeDasharray="7 9"
            opacity={0.65}
            data-sim-flow="h"
            data-berth-flow={pipeInbound ? "to-tanks" : "to-ship"}
          />
        )}

        {hasRail && railBranchPath && (
          <>
            <path
              d={railBranchPath}
              fill="none"
              stroke={STROKE_DIM}
              strokeWidth={SW}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {flowAnimOn && railSlotActive && (
              <path
                d={railBranchPath}
                fill="none"
                stroke={FLOW_COLOR}
                strokeWidth={SW}
                strokeDasharray="7 9"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.65}
                data-sim-flow="p"
                data-berth-flow={railFlowBerthAttr}
              />
            )}
          </>
        )}

        {tankLayout.centers.map((t) => (
          <line
            key={`tap-${t.i}`}
            x1={t.cx}
            y1={t.cy + t.r}
            x2={t.cx}
            y2={manifoldY}
            stroke={STROKE_DIM}
            strokeWidth={SW}
            strokeLinecap="round"
          />
        ))}

        {tankLayout.centers.map((t) => {
          const surfaceY = invLevelY(t.cy, t.r, commingleStack.totalInv);
          const borrowLimitY =
            borrowLimitTonnes > 0 ? invLevelY(t.cy, t.r, -borrowLimitTonnes) : undefined;
          return (
            <TankBlueprintDetail
              key={`t${t.i}`}
              cx={t.cx}
              cy={t.cy}
              r={t.r}
              surfaceY={surfaceY}
              invRatio={invRatio}
              borrowLimitY={borrowLimitY}
            />
          );
        })}

        {/* Stock chart (geometry) */}
        {(() => {
          const px = VB_W - MARGIN - STOCK_W + 8;
          const cTop = TF_TOP + TF_TITLE_H + 20;
          const cH = Math.max(80, TF_BOT - cTop - 24);
          const barW = 56;
          const barX = px + 8;
          const borrowH =
            borrowLimitTonnes > 0 && commingleStack.totalCap > 0
              ? cH * (borrowLimitTonnes / commingleStack.totalCap)
              : 0;
          const zeroY = cTop + cH;
          const positiveH =
            commingleStack.totalInv > 0
              ? Math.min(cH, cH * (commingleStack.totalInv / commingleStack.totalCap))
              : 0;
          const negativeH =
            commingleStack.totalInv < 0 && borrowLimitTonnes > 0
              ? Math.min(
                  borrowH,
                  borrowH * (Math.abs(commingleStack.totalInv) / borrowLimitTonnes)
                )
              : 0;
          let y = zeroY;
          return (
            <g>
              <line
                x1={barX - 2}
                y1={cTop}
                x2={barX + barW + 2}
                y2={cTop}
                stroke={CAPACITY_STROKE}
                strokeWidth={SW_HAIR}
                strokeDasharray={CAPACITY_DASH}
                strokeLinecap="butt"
                opacity={0.95}
              >
                <title>
                  Terminal storage capacity ({Math.round(commingleStack.totalCap).toLocaleString()} t)
                </title>
              </line>
              {borrowH > 0 && (
                <line
                  x1={barX - 2}
                  y1={zeroY + borrowH}
                  x2={barX + barW + 2}
                  y2={zeroY + borrowH}
                  stroke={BORROW_STROKE}
                  strokeWidth={SW_HAIR}
                  strokeDasharray={BORROW_DASH}
                  strokeLinecap="butt"
                  opacity={0.95}
                >
                  <title>
                    Max borrowing limit (−{Math.round(borrowLimitTonnes).toLocaleString()} t)
                  </title>
                </line>
              )}
              {commingleStack.totalInv > 0 &&
                commingleStack.parts.map((p, si) => {
                  const h =
                    commingleStack.totalInv > 0
                      ? (p.vol / commingleStack.totalInv) * positiveH
                      : 0;
                  y -= h;
                  return (
                    <rect
                      key={si}
                      x={barX}
                      y={y}
                      width={barW}
                      height={h}
                      fill={p.color}
                      fillOpacity={0.7}
                      stroke={STROKE}
                      strokeWidth={0.6}
                    />
                  );
                })}
              {negativeH > 0 && (
                <rect
                  x={barX}
                  y={zeroY}
                  width={barW}
                  height={negativeH}
                  fill={BORROW_STROKE}
                  fillOpacity={0.35}
                  stroke={BORROW_STROKE}
                  strokeWidth={0.6}
                  strokeDasharray="3 2"
                />
              )}
            </g>
          );
        })()}

        {resourceRows.map((resource, idx) => {
          if (resource.type === "rail_siding") return null;
          const x = laneXs[idx] ?? VB_W / 2;
          const slot = slotByResource.get(resource.id);
          const vis =
            slot && config?.startDate
              ? getVesselVisual(slot, resource, simStartMs, currentHour)
              : { phase: "idle" as const, legT: 0, pumpProgress: 0 };
          const active = vis.phase !== "idle";
          const showFlow = flowAnimOn && active;
          const dir = slot?.direction === "inbound" ? "to-tanks" : "to-ship";

          let loadingArmTipX = x;
          let loadingArmTipY = DOCK_Y - BERTH_HALF_BEAM - 4;
          if (slot && config?.startDate && active) {
            const v = getVesselVisual(slot, resource, simStartMs, currentHour, preOH, postOH);
            const vMode = slot.mode === "barge" ? "barge" : slot.mode === "train" ? "train" : "ship";
            if (vMode !== "train") {
              const vx = berthVesselX(v.phase, v.legT, x);
              const vy = berthVesselY(v.phase, v.legT);
              loadingArmTipX = vx + SHIP_DECK_CONN_LOCAL_X * SHIP_SCALE;
              loadingArmTipY = vy + SHIP_DECK_CONN_LOCAL_Y * SHIP_SCALE;
            }
          }

          return (
            <g key={resource.id}>
              <line
                x1={x}
                y1={manifoldY}
                x2={x}
                y2={BERTH_RISER_TOP}
                stroke={STROKE}
                strokeWidth={SW}
                strokeLinecap="round"
              />
              <line
                x1={x}
                y1={BERTH_RISER_TOP}
                x2={x}
                y2={QUAY_Y - 2}
                stroke={STROKE}
                strokeWidth={SW}
                strokeLinecap="round"
              />
              {showFlow && (
                <>
                  <line
                    x1={x}
                    y1={manifoldY}
                    x2={x}
                    y2={BERTH_RISER_TOP}
                    stroke={FLOW_COLOR}
                    strokeWidth={SW}
                    strokeDasharray="7 9"
                    opacity={0.65}
                    data-sim-flow="v"
                    data-berth-flow={dir}
                  />
                  <line
                    x1={x}
                    y1={BERTH_RISER_TOP}
                    x2={x}
                    y2={QUAY_Y - 2}
                    stroke={FLOW_COLOR}
                    strokeWidth={SW}
                    strokeDasharray="7 9"
                    opacity={0.65}
                    data-sim-flow="v"
                    data-berth-flow={dir}
                  />
                </>
              )}
              <circle cx={x} cy={QUAY_Y} r={4.5} fill="none" stroke={STROKE} strokeWidth={SW_HAIR} />
              {slot && vis.phase === "pump" && (
                <>
                  <line
                    x1={x}
                    y1={QUAY_Y}
                    x2={loadingArmTipX}
                    y2={loadingArmTipY}
                    stroke={STROKE}
                    strokeWidth={SW}
                    strokeLinecap="round"
                  />
                  {flowAnimOn && (
                    <line
                      x1={x}
                      y1={QUAY_Y}
                      x2={loadingArmTipX}
                      y2={loadingArmTipY}
                      stroke={FLOW_COLOR}
                      strokeWidth={SW}
                      strokeDasharray="7 9"
                      opacity={0.65}
                      data-sim-flow="arm"
                      data-berth-flow={dir}
                    />
                  )}
                </>
              )}
            </g>
          );
        })}

        {resourceRows.some((r) => r.type === "rail_siding") && (
          <g>
            <line
              x1={railXEnd}
              y1={RAIL_Y - 4}
              x2={railXStart}
              y2={RAIL_Y - 4}
              stroke={STROKE_DIM}
              strokeWidth={SW}
            />
            <line
              x1={railXEnd}
              y1={RAIL_Y + 4}
              x2={railXStart}
              y2={RAIL_Y + 4}
              stroke={STROKE_DIM}
              strokeWidth={SW}
            />
            {Array.from({ length: Math.floor((railXStart - railXEnd) / 18) + 1 }).map((_, i) => {
              const sx = railXEnd + i * 18;
              return sx <= railXStart ? (
                <rect
                  key={i}
                  x={sx - 1}
                  y={RAIL_Y - 10}
                  width={3}
                  height={20}
                  fill="none"
                  stroke={STROKE_SOFT}
                  strokeWidth={SW_HAIR}
                  rx={0.5}
                />
              ) : null;
            })}
            <line
              x1={railXEnd}
              y1={RAIL_Y - 7}
              x2={railXEnd}
              y2={RAIL_Y + 7}
              stroke={STROKE}
              strokeWidth={SW}
              strokeLinecap="square"
            />
          </g>
        )}

        <line x1={MARGIN} y1={QUAY_Y} x2={VB_W - MARGIN} y2={QUAY_Y} stroke={STROKE} strokeWidth={SW} strokeLinecap="round" />

        {resourceRows.map((resource) => {
          const slot = slotByResource.get(resource.id);
          if (!slot) return null;
          const vis = getVesselVisual(slot, resource, simStartMs, currentHour, preOH, postOH);
          if (vis.phase === "idle") return null;
          const col = customerColor(slot.customerId);
          const mode = resource.type === "rail_siding" ? "train" : slot.mode === "barge" ? "barge" : "ship";
          const barY = mode === "train" ? 20 : mode === "barge" ? 28 : 27;
          const barW = mode === "train" ? 72 : mode === "barge" ? 60 : 72;
          const innerW = mode === "train" ? 68 : mode === "barge" ? 56 : 68;

          return (
            <g key={`v-${slot.id}`}>
              <g data-vessel-slot={slot.id}>
                <VesselShape mode={mode} color={col} />
                {vis.phase === "pump" && (
                  <>
                    <rect
                      x={-barW / 2}
                      y={barY}
                      width={barW}
                      height={6}
                      rx={2}
                      fill="none"
                      stroke={STROKE_DIM}
                      strokeWidth={SW_HAIR}
                    />
                    <rect
                      x={-innerW / 2}
                      y={barY + 1.5}
                      width={innerW * vis.pumpProgress}
                      height={3.5}
                      rx={1}
                      fill={col}
                      fillOpacity={0.75}
                      stroke="none"
                    />
                  </>
                )}
              </g>
            </g>
          );
        })}
      </g>

      {/* Text & dimensions (no jitter) */}
      <g style={{ pointerEvents: "none" }}>
        <text x={VB_W / 2} y={PIPE_Y - 10} textAnchor="middle" style={DIM_TEXT}>
          L 1200mm
        </text>
        <ZoneChipLabel x={MARGIN} y={2} label="Pipeline" />
        <ZoneChipLabel x={MARGIN + 8} y={TF_TOP + 8} label="Tank Farm" />

        {tankLayout.centers.map((t) => {
          const surfaceY = invLevelY(t.cy, t.r, commingleStack.totalInv);
          const pct = Math.round(invRatio * 100);
          return (
            <g key={`tl${t.i}`}>
              <text x={t.cx} y={t.cy + 4} textAnchor="middle" style={LBL_SM}>
                T{t.i + 1}
              </text>
              {Math.abs(invRatio) > 0.005 && (
                <text x={t.cx + t.r + 10} y={surfaceY + 3} style={DIM_TEXT}>
                  {pct}%
                </text>
              )}
            </g>
          );
        })}

        {(() => {
          const px = VB_W - MARGIN - STOCK_W + 8;
          const cTop = TF_TOP + TF_TITLE_H + 20;
          const cH = Math.max(80, TF_BOT - cTop - 24);
          const barW = 56;
          const barX = px + 8;
          const legX = px + barW + 28;
          const borrowH =
            borrowLimitTonnes > 0 && commingleStack.totalCap > 0
              ? cH * (borrowLimitTonnes / commingleStack.totalCap)
              : 0;
          return (
            <g>
              <text x={px} y={cTop - 6} style={LBL}>
                Stock
              </text>
              <text x={barX} y={cTop + cH + (borrowH > 0 ? borrowH : 0) + 16} style={LBL_SM}>
                {commingleStack.totalInv >= 1000
                  ? `${(commingleStack.totalInv / 1000).toFixed(1)} / ${(commingleStack.totalCap / 1000).toFixed(0)} kt`
                  : `${commingleStack.totalInv.toFixed(0)} / ${commingleStack.totalCap.toFixed(0)} t`}
                {borrowLimitTonnes > 0 ? ` · borrow floor −${borrowLimitTonnes.toLocaleString()} t` : ""}
              </text>
              {commingleStack.parts.slice(0, 5).map((p, i) => (
                <g key={p.id} transform={`translate(${legX}, ${cTop + 6 + i * 14})`}>
                  <rect x={0} y={-6} width={9} height={9} fill={p.color} fillOpacity={0.85} rx={1.5} stroke={STROKE} strokeWidth={0.5} />
                  <text x={14} y={0} style={LBL_LEGEND}>
                    {customerById.get(p.id)?.name?.slice(0, 16) ?? p.id.slice(0, 8)}
                  </text>
                </g>
              ))}
            </g>
          );
        })()}

        {resourceRows.map((resource, idx) => {
          if (resource.type === "rail_siding") return null;
          const x = laneXs[idx] ?? VB_W / 2;
          return (
            <text key={`bn-${resource.id}`} x={x} y={TF_BOT + 22} textAnchor="middle" style={LBL_SM}>
              {resource.name}
            </text>
          );
        })}

        {resourceRows.some((r) => r.type === "rail_siding") && (
          <g>
            <text x={(railXEnd + railXStart) / 2} y={RAIL_Y - 18} textAnchor="middle" style={LBL_SM}>
              Rail Siding
            </text>
            <text x={railXEnd + 6} y={RAIL_Y + 22} style={DIM_TEXT}>
              1435mm
            </text>
          </g>
        )}

        <text x={MARGIN} y={VB_H - 12} style={{ ...LBL, fill: "rgba(255,255,255,0.85)" }}>
          Waterway
        </text>
      </g>
    </svg>
  );
}
