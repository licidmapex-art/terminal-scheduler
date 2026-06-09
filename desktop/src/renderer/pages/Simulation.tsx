import { useState, useEffect, useMemo, useCallback } from "react";
import { ClipboardList, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import TerminalMapSvg from "../components/TerminalMapSvg";
import { PageTitleWithHelp, HelpPopover } from "../components/HelpPopover";
import {
  useSimulationData,
  isAnyOperationActive,
} from "../hooks/useSimulationData";

const HOUR_MS = 3_600_000;

export default function Simulation() {
  const {
    customers, resourceRows, slots, timelineStart,
    config, loadError, totalHourCount, simStartMs, customerColor,
    getInventoryAtHour, customerById, hasTimelineData,
    tankCount, totalCapacity, pipeRate, pipeInbound, resources,
  } = useSimulationData();

  const [currentHour, setCurrentHour] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [recentEvents, setRecentEvents] = useState<string[]>([]);

  const lastHourIndex = Math.max(0, totalHourCount - 1);

  useEffect(() => {
    setCurrentHour((h) => Math.min(h, lastHourIndex));
  }, [lastHourIndex]);

  const operationActive = useMemo(
    () =>
      isAnyOperationActive(
        slots,
        resourceRows,
        simStartMs,
        currentHour,
        config?.preOpsHours ?? 0,
        config?.postOpsHours ?? 0,
      ),
    [slots, resourceRows, simStartMs, currentHour, config?.preOpsHours, config?.postOpsHours],
  );

  const effectiveSpeed = operationActive ? Math.max(0.01, speed / 10) : speed;

  useEffect(() => {
    if (!isPlaying) return;
    const tick = () => {
      setCurrentHour((h) => {
        if (h >= lastHourIndex) {
          setIsPlaying(false);
          return lastHourIndex;
        }
        return h + 1;
      });
    };
    const interval = window.setInterval(tick, Math.max(16, 1000 / effectiveSpeed));
    return () => window.clearInterval(interval);
  }, [isPlaying, effectiveSpeed, lastHourIndex]);

  const currentTime = useMemo(() => {
    if (!config?.startDate) return new Date();
    return new Date(new Date(config.startDate).getTime() + currentHour * HOUR_MS);
  }, [config, currentHour]);

  const flowAnimOn = isPlaying && (pipeRate > 0 || operationActive);

  /* ── Event ticker ── */
  useEffect(() => {
    if (!config?.startDate) return;
    const simStart = new Date(config.startDate).getTime();
    const newEvents: string[] = [];

    for (const slot of slots) {
      const customer = customerById.get(slot.customerId);
      const resource = resources.find((r) => r.id === slot.resourceId);
      if (!customer || !resource) continue;

      const startH = Math.round((new Date(slot.start).getTime() - simStart) / HOUR_MS);
      const endH = Math.round((new Date(slot.end).getTime() - simStart) / HOUR_MS);

      if (startH === currentHour) {
        newEvents.push(
          `${customer.name}: ${slot.mode} ${slot.direction} started at ${resource.name} (${slot.volume.toLocaleString()}t)`,
        );
      }
      if (endH === currentHour) {
        newEvents.push(
          `${customer.name}: ${slot.mode} ${slot.direction} completed at ${resource.name}`,
        );
      }
    }

    if (newEvents.length > 0) {
      setRecentEvents((prev) => [...prev.slice(-20), ...newEvents]);
    }
  }, [currentHour, slots, config, resources, customerById]);

  const tickerLines = recentEvents.slice(-3);

  /* ── Empty / error states ── */

  if (!hasTimelineData) {
    return (
      <div>
        <div className="page-header">
          <div>
            <PageTitleWithHelp
              title="Visualization"
              help="Animated playback of inventory and berth activity"
            />
          </div>
        </div>
        <div className="card" style={{ padding: 48, textAlign: "center", color: "#64748b" }}>
          Run the scheduler first to use the simulation view.
        </div>
      </div>
    );
  }

  if (loadError || !config?.startDate) {
    return (
      <div>
        <div className="page-header">
          <h1 className="page-title">Visualization</h1>
        </div>
        <div className="alert alert-error">{loadError ?? "Add a simulation configuration under Terminal."}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title-row">
            <h1 className="page-title">Terminal visualization</h1>
            <HelpPopover
              label="Visualization help"
              content="Playback from saved inventory timeline and scheduled berth slots."
            />
          </div>
          {(timelineStart || operationActive) && (
            <p className="page-subtitle" style={{ marginTop: 4 }}>
              {timelineStart ? `From ${new Date(timelineStart).toLocaleDateString("en-GB")}` : ""}
              {timelineStart && operationActive ? " · " : ""}
              {operationActive ? "Auto slow-down during berth operations" : ""}
            </p>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 24, overflow: "hidden" }}>
        {/* Terminal map */}
        <div style={{ width: "100%", aspectRatio: "1200 / 700", position: "relative", background: "#0047AB" }}>
          <TerminalMapSvg
            customers={customers}
            resourceRows={resourceRows}
            slots={slots}
            config={config}
            currentHour={currentHour}
            isPlaying={isPlaying}
            effectiveSpeed={effectiveSpeed}
            flowAnimOn={flowAnimOn}
            pipeRate={pipeRate}
            pipeInbound={pipeInbound}
            tankCount={tankCount}
            totalCapacity={totalCapacity}
            getInventoryAtHour={getInventoryAtHour}
            customerColor={customerColor}
            customerById={customerById}
          />
        </div>

        {/* Playback controls */}
        <div style={{ padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary" onClick={() => setCurrentHour(0)} style={{ padding: "6px 12px" }}>
              <SkipBack size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setIsPlaying((p) => !p)}
              style={{ padding: "6px 16px", minWidth: 80 }}
            >
              {isPlaying ? (
                <>
                  <Pause size={16} strokeWidth={2} /> Pause
                </>
              ) : (
                <>
                  <Play size={16} strokeWidth={2} /> Play
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setCurrentHour(lastHourIndex)}
              style={{ padding: "6px 12px" }}
            >
              <SkipForward size={16} strokeWidth={2} />
            </button>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#64748b", marginRight: 4 }}>Speed</span>
              {[1, 10, 100, 1000].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`btn ${speed === s ? "btn-primary" : "btn-secondary"}`}
                  style={{ padding: "4px 10px", fontSize: 12 }}
                  onClick={() => setSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </div>
            <div
              style={{
                marginLeft: "auto",
                padding: "8px 16px",
                borderRadius: 8,
                background: "#dbeafe",
                border: "1px solid #93c5fd",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 14,
                fontWeight: 600,
                color: "#1e3a8a",
                whiteSpace: "nowrap",
              }}
            >
              {currentTime.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}{" "}
              {currentTime.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>

          <div style={{ position: "relative" }}>
            <input
              type="range"
              min={0}
              max={lastHourIndex}
              value={Math.min(currentHour, lastHourIndex)}
              onChange={(e) => setCurrentHour(Number(e.target.value))}
              style={{ width: "100%", cursor: "pointer" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              <span>{new Date(config.startDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
              <span>Hour {currentHour} / {lastHourIndex}</span>
              <span>{new Date(config.endDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
            </div>
          </div>

          <div style={{ minHeight: 40, fontSize: 12, color: "#475569", borderTop: "1px solid #e2e8f0", paddingTop: 8 }}>
            {tickerLines.length === 0 ? (
              <span style={{ color: "#94a3b8" }}>—</span>
            ) : (
              tickerLines.map((e, i) => (
                <div
                  key={`${e}-${i}`}
                  style={{
                    opacity: i === tickerLines.length - 1 ? 1 : 0.45,
                    marginBottom: 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 6
                  }}
                >
                  <ClipboardList size={14} strokeWidth={2} color="#64748b" aria-hidden />
                  {e}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
