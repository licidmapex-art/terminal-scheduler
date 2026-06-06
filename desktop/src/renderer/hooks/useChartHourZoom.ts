import { useState, useEffect, useCallback, type WheelEvent } from "react";

/** Match Gantt chart zoom factor. */
const ZOOM_FACTOR = 1.2;
/** Minimum visible window (hours). */
const MIN_SPAN_HOURS = 24;

export interface ChartHourZoom {
  viewDomain: [number, number];
  zoomIn: (cursorFraction?: number) => void;
  zoomOut: (cursorFraction?: number) => void;
  handleWheel: (e: WheelEvent<HTMLElement>) => void;
  resetZoom: () => void;
  isZoomed: boolean;
}

export function useChartHourZoom(maxHour: number): ChartHourZoom {
  const fullHi = Math.max(0, maxHour);

  const [viewDomain, setViewDomain] = useState<[number, number]>(() => [0, fullHi]);

  useEffect(() => {
    setViewDomain([0, fullHi]);
  }, [fullHi]);

  const applyZoom = useCallback(
    (factor: number, cursorFraction?: number) => {
      setViewDomain(([lo, hi]) => {
        const span = hi - lo || 1;
        const center =
          cursorFraction != null && Number.isFinite(cursorFraction)
            ? lo + Math.max(0, Math.min(1, cursorFraction)) * span
            : (lo + hi) / 2;
        const fullSpan = fullHi || 1;
        const minSpan = Math.min(MIN_SPAN_HOURS, fullSpan);
        let newSpan = span / factor;
        newSpan = Math.max(minSpan, Math.min(fullSpan, newSpan));
        let newLo = center - newSpan / 2;
        let newHi = center + newSpan / 2;
        if (newLo < 0) {
          newHi -= newLo;
          newLo = 0;
        }
        if (newHi > fullHi) {
          newLo -= newHi - fullHi;
          newHi = fullHi;
        }
        newLo = Math.max(0, newLo);
        newHi = Math.min(fullHi, newHi);
        if (newHi - newLo < minSpan) {
          if (newLo === 0) newHi = Math.min(fullHi, minSpan);
          else if (newHi === fullHi) newLo = Math.max(0, fullHi - minSpan);
        }
        return [newLo, newHi];
      });
    },
    [fullHi]
  );

  const zoomIn = useCallback(
    (cursorFraction?: number) => applyZoom(ZOOM_FACTOR, cursorFraction),
    [applyZoom]
  );
  const zoomOut = useCallback(
    (cursorFraction?: number) => applyZoom(1 / ZOOM_FACTOR, cursorFraction),
    [applyZoom]
  );

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLElement>) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const cursorFraction = (e.clientX - rect.left) / Math.max(rect.width, 1);
      if (e.deltaY < 0) zoomIn(cursorFraction);
      else zoomOut(cursorFraction);
    },
    [zoomIn, zoomOut]
  );

  const resetZoom = useCallback(() => setViewDomain([0, fullHi]), [fullHi]);
  const isZoomed = viewDomain[0] > 0 || viewDomain[1] < fullHi;

  return { viewDomain, zoomIn, zoomOut, handleWheel, resetZoom, isZoomed };
}

export function formatHourDomainLabel(
  domain: [number, number],
  chartStartDate: Date | null
): string | null {
  if (!chartStartDate || Number.isNaN(chartStartDate.getTime())) return null;
  const fmt = (h: number) =>
    new Date(chartStartDate.getTime() + h * 3_600_000).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  return `${fmt(domain[0])} – ${fmt(domain[1])}`;
}
