import type { CustomerThroughputOverview, ModeThroughputLine } from "../lib/customerThroughputOverview";

function fmt(v: number): string {
  const rounded = Math.round(v) || 0;
  return `${rounded.toLocaleString()} t`;
}

function modeLabel(m: ModeThroughputLine): string {
  const name = m.mode.charAt(0).toUpperCase() + m.mode.slice(1);
  if (m.meps <= 0) return name;
  return `${name} (${m.targetSlots})`;
}

function DirectionRows({
  label,
  total,
  modes,
  pipelineTonnes,
  pipelineLabel
}: {
  label: string;
  total: number;
  modes: ModeThroughputLine[];
  pipelineTonnes: number;
  pipelineLabel: string;
}) {
  const hasModes = modes.length > 0;
  const hasPipeline = pipelineTonnes > 0;
  const hasAny = hasModes || hasPipeline;

  return (
    <div className="ct-direction">
      <div className="ct-direction-head">
        <span className="ct-direction-label">{label}</span>
        <span className="ct-direction-total">{fmt(total)}</span>
      </div>
      {hasAny ? (
        <ul className="ct-sub">
          {modes.map((m) => (
            <li key={m.laneIndex}>
              <span className="ct-sub-label">{modeLabel(m)}</span>
              <span className="ct-sub-val">{fmt(m.tonnes)}</span>
            </li>
          ))}
          {hasPipeline && (
            <li>
              <span className="ct-sub-label">{pipelineLabel}</span>
              <span className="ct-sub-val">{fmt(pipelineTonnes)}</span>
            </li>
          )}
        </ul>
      ) : (
        <p className="ct-empty">Not configured</p>
      )}
    </div>
  );
}

export default function CustomerThroughputOverviewPanel({
  overview
}: {
  overview: CustomerThroughputOverview;
}) {
  const inboundTotal = overview.inboundTransportTonnes + overview.inboundPipelineTonnes;
  const outboundTotal = Math.max(0, overview.calculatedOutboundTonnes) + overview.outboundPipelineTonnes;

  return (
    <div className="ct-simple">
      <DirectionRows
        label="Inbound"
        total={inboundTotal}
        modes={overview.inboundModes}
        pipelineTonnes={overview.inboundPipelineTonnes}
        pipelineLabel="Pipeline in"
      />
      <DirectionRows
        label="Outbound"
        total={outboundTotal}
        modes={overview.outboundModes}
        pipelineTonnes={overview.outboundPipelineTonnes}
        pipelineLabel="Pipeline out"
      />
    </div>
  );
}
