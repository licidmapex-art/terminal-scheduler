import { formatHourDomainLabel } from "../hooks/useChartHourZoom";

interface Props {
  viewDomain: [number, number];
  chartStartDate: Date | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  isZoomed: boolean;
}

export default function ChartHourZoomToolbar({
  viewDomain,
  chartStartDate,
  onZoomIn,
  onZoomOut,
  onReset,
  isZoomed
}: Props) {
  const rangeLabel = formatHourDomainLabel(viewDomain, chartStartDate);

  return (
    <div className="chart-hour-zoom-toolbar">
      <button type="button" className="btn btn-secondary chart-hour-zoom-btn" onClick={onZoomIn} title="Zoom in">
        ＋
      </button>
      <button type="button" className="btn btn-secondary chart-hour-zoom-btn" onClick={onZoomOut} title="Zoom out">
        －
      </button>
      {isZoomed ? (
        <button type="button" className="btn btn-secondary" onClick={onReset}>
          Reset zoom
        </button>
      ) : null}
      <span className="chart-hour-zoom-hint">Scroll wheel to zoom (cursor-centered)</span>
      {rangeLabel ? <span className="chart-hour-zoom-range">{rangeLabel}</span> : null}
    </div>
  );
}
