import type { CustomerThroughputOverview, ModeThroughputLine } from "../lib/customerThroughputOverview";

function fmt(v: number): string {
  // Guard against -0 from floating-point arithmetic
  const rounded = Math.round(v) || 0;
  return `${rounded.toLocaleString()} t`;
}

function fmt2(v: number, signed: boolean): string {
  const rounded = Math.round(v).toLocaleString();
  if (!signed) return `${rounded} t`;
  if (v > 0) return `+${rounded} t`;
  if (v < 0) return `−${Math.abs(v).toLocaleString()} t`;
  return "0 t";
}

/** Simple two-block view used on the customer cards. */
function CompactOverview({ overview }: { overview: CustomerThroughputOverview }) {
  // Physical inbound = declared transport + inbound pipeline
  const inboundTotal = overview.inboundTransportTonnes + overview.inboundPipelineTonnes;
  // Physical outbound = berth transport + outbound pipeline (pipeline carries product out too)
  const outboundTotal = Math.max(0, overview.calculatedOutboundTonnes) + overview.outboundPipelineTonnes;

  return (
    <div className="ct-simple">
      <DirectionRows
        label="Inbound"
        total={inboundTotal}
        modes={overview.inboundModes}
        pipelineTonnes={overview.inboundPipelineTonnes}
        pipelineLabel="pipeline in"
      />
      <DirectionRows
        label="Outbound"
        total={outboundTotal}
        modes={overview.outboundModes}
        pipelineTonnes={overview.outboundPipelineTonnes}
        pipelineLabel="pipeline out"
      />
    </div>
  );
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
            <li key={m.mode}>
              <span className="ct-sub-label" style={{ textTransform: "capitalize" }}>{m.mode}</span>
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

/** Detailed formula table used in the form summary. */
function DetailedOverview({ overview }: { overview: CustomerThroughputOverview }) {
  const periodLabel = `${Math.round(overview.periodHours).toLocaleString()} h`;

  return (
    <div className="ct-detail">
      <div className="ct-detail-meta">
        <span>Window</span><span>{periodLabel}</span>
        <span>Storage share</span><span>{overview.storageShare}%</span>
      </div>

      <div className="ct-detail-block">
        <div className="ct-detail-title">Inbound</div>
        <table className="data-table ct-detail-table">
          <tbody>
            {overview.inboundModes.map((m) => (
              <tr key={m.mode}>
                <td style={{ textTransform: "capitalize" }}>{m.mode}</td>
                <td style={{ textAlign: "right" }}>{fmt(m.tonnes)}</td>
              </tr>
            ))}
            {overview.inboundPipelineTonnes > 0 && (
              <tr>
                <td>Pipeline ({overview.inboundPipelineRatePerHour.toLocaleString()} t/h)</td>
                <td style={{ textAlign: "right" }}>{fmt2(overview.inboundPipelineTonnes, true)}</td>
              </tr>
            )}
            {overview.inboundModes.length === 0 && overview.inboundPipelineTonnes === 0 && (
              <tr><td colSpan={2} style={{ color: "#94a3b8", fontStyle: "italic" }}>Not configured</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="ct-detail-block">
        <div className="ct-detail-title">
          Calculated outbound
          <span className="ct-detail-total">{fmt(overview.calculatedOutboundTonnes)}</span>
        </div>
        <p className="ct-detail-desc">
          Declared inbound{overview.inboundPipelineTonnes > 0 ? " + inbound pipeline" : ""}
          {overview.outboundPipelineTonnes > 0 ? " − outbound pipeline" : ""}
        </p>
        <table className="data-table ct-detail-table">
          <tbody>
            <tr>
              <td>Inbound transport</td>
              <td style={{ textAlign: "right" }}>{fmt2(overview.inboundTransportTonnes, true)}</td>
            </tr>
            {overview.inboundPipelineTonnes > 0 && (
              <tr>
                <td>Inbound pipeline ({overview.inboundPipelineRatePerHour.toLocaleString()} t/h)</td>
                <td style={{ textAlign: "right" }}>{fmt2(overview.inboundPipelineTonnes, true)}</td>
              </tr>
            )}
            {overview.outboundPipelineTonnes > 0 && (
              <tr>
                <td>Outbound pipeline ({overview.outboundPipelineRatePerHour.toLocaleString()} t/h)</td>
                <td style={{ textAlign: "right" }}>{fmt2(-overview.outboundPipelineTonnes, true)}</td>
              </tr>
            )}
            <tr className="ct-detail-sum-row">
              <td><strong>Total</strong></td>
              <td style={{ textAlign: "right" }}><strong>{fmt(overview.calculatedOutboundTonnes)}</strong></td>
            </tr>
          </tbody>
        </table>
        {overview.outboundModes.length > 0 && (
          <>
            <p className="ct-detail-desc" style={{ marginTop: 10 }}>Berth split</p>
            <table className="data-table ct-detail-table">
              <thead>
                <tr>
                  <th>Mode</th>
                  <th style={{ textAlign: "right" }}>Share</th>
                  <th style={{ textAlign: "right" }}>MEPS</th>
                  <th style={{ textAlign: "right" }}>Tonnes</th>
                </tr>
              </thead>
              <tbody>
                {overview.outboundModes.map((m) => (
                  <tr key={m.mode}>
                    <td style={{ textTransform: "capitalize" }}>{m.mode}</td>
                    <td style={{ textAlign: "right" }}>{Math.round(m.sharePct)}%</td>
                    <td style={{ textAlign: "right" }}>{m.meps.toLocaleString()} t</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{fmt(m.tonnes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

export default function CustomerThroughputOverviewPanel({
  overview,
  compact
}: {
  overview: CustomerThroughputOverview;
  compact?: boolean;
}) {
  return compact ? (
    <CompactOverview overview={overview} />
  ) : (
    <DetailedOverview overview={overview} />
  );
}
