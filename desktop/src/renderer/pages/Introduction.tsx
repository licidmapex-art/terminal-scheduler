import ErrorBoundary from "../components/ErrorBoundary";

export default function Introduction() {
  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Introduction</h1>
            <p className="page-subtitle">
              How the hour-by-hour scheduler works: legs, pacing, inventory, and how Simulation log icons line up with
              engine rules.
            </p>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 24 }}>
          <div className="card-title">How scheduling works</div>
          <div
            style={{
              fontSize: 14,
              color: "#475569",
              lineHeight: 1.65,
              maxWidth: 900
            }}
          >
            <p style={{ marginTop: 0, marginBottom: 12 }}>
              The scheduler runs a single <strong>forward pass</strong> over the simulation horizon, <strong>hour by hour</strong>.
              At the start of each hour it updates inventory from the <strong>pipeline</strong> and from <strong>cargo
              already moving</strong> on berths (including your pre-/post-ops laytime). It then tries to <strong>start at
              most one new load start</strong> per customer <strong>transport leg</strong> (customer + inbound/outbound +
              ship/barge/train). Different legs (other customers or directions) can still start in the same hour. Each
              attempt is subject to the constraints below.
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>Who do constraints apply to?</strong> For <strong>fixed band</strong>, <strong>shared inventory</strong>,
              and <strong>time-shared storage</strong>, slot <strong>targets</strong>, <strong>pace</strong>, and{" "}
              <strong>roundtrip</strong> limits are tracked <strong>per leg</strong> — i.e. per <strong>customer</strong> and{" "}
              <strong>direction</strong> and <strong>mode</strong> together — not as one shared budget per transport mode
              across the whole terminal. (Two customers both using inbound ships each have their own counts and pacing.) The{" "}
              <strong>exception</strong> is <strong>shared shipping</strong>: for that mode only, slot targets and pacing for
              a given <strong>direction + mode</strong> (e.g. all inbound ships) are combined across customers, while
              inventory checks still use the terminal pool or per-customer bands as usual.
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>Which leg runs first in that hour?</strong> Active legs are sorted by a <strong>priority score
              </strong> (lower = tried earlier), then by customer name. The score is <strong>different for inbound vs
              outbound</strong> so that berth competition follows operational need, not raw tank size alone.
            </p>
            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>
              Priority score (Simulation log tooltips — same as the sort)
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>Inbound legs (ships, barges loading in).</strong> The engine compares each customer&apos;s{" "}
              <strong>attributed inventory</strong> (or pool share under shared shipping) to the <strong>total rate at
              which that customer is expected to <em>ship out</em></strong> inventory: terminal <strong>outbound
              pipeline</strong> (t/d when the pipeline pulls stock) <strong>plus</strong> scheduled outbound lift spread:{" "}
              <code style={{ fontSize: 13 }}>(outbound targetSlots × outbound MEPS) / horizon days</code>. The score is{" "}
              <strong>inventory ÷ that outbound pressure (t/d)</strong>. <strong>Lower</strong> means stock will run
              short sooner relative to outbound demand — the customer is prioritised for <strong>inbound cargo</strong> to
              feed outbound, rather than whoever has the largest empty tank volume.
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>Outbound legs (ships, barges loading out).</strong> The score uses <strong>headroom</strong>{" "}
              (max capacity minus current inventory) versus the <strong>total rate at which inventory is expected to{" "}
              <em>arrive</em></strong>: terminal <strong>inbound pipeline</strong> (t/d) <strong>plus</strong> scheduled
              inbound lift spread from the <strong>inbound</strong> target. It is{" "}
              <strong>headroom ÷ total inbound fill (t/d)</strong>. <strong>Lower</strong> means the tank will top out
              sooner if nothing is discharged — those legs are tried first so you <strong>make room</strong> before becoming
              receiving-limited. If there is no inbound fill at all, the score falls back to <strong>raw headroom</strong>{" "}
              (fullest tanks first). <strong>Higher</strong> headroom (emptier tank) sorts later for outbound.
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>Horizon and targets.</strong> <code style={{ fontSize: 13 }}>horizon days</code> is the simulation
              length; <code style={{ fontSize: 13 }}>targetSlots</code> and MEPS come from declared throughput, so berth
              spreads match the same pacing targets as elsewhere.
            </p>
            <p style={{ marginBottom: 12, fontSize: 13, color: "#64748b" }}>
              <strong>Analytics summary DoC</strong> (when shown) combines both pressures into one customer-level figure
              by taking the <strong>minimum</strong> of the two ratios above when both apply — whichever bottleneck is
              tightest.
            </p>
            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>
              Constraints (icons match the Simulation log when a leg is idle with that block)
            </p>
            <ul style={{ margin: "0 0 12px", paddingLeft: 22 }}>
              <li style={{ marginBottom: 8 }}>
                <strong>Target count</strong> — Cannot schedule more slot starts for a <strong>leg</strong> than that leg&apos;s
                computed target from declared throughput and MEPS (and roundtrip limits), <strong>per customer × direction ×
                mode</strong> unless you use <strong>shared shipping</strong>, where inbound/outbound targets of the same mode
                are combined across customers. (No separate log icon — the leg may idle for other reasons once the target is
                reached.)
              </li>
              <li style={{ marginBottom: 8 }}>
                <span aria-hidden>⏸</span> <strong>Pace ahead</strong> — Slot starts are throttled so visits are spread across
                the horizon, not only bunched at the beginning (continuous pace target <strong>per leg</strong>, except{" "}
                <strong>shared shipping</strong> where pace is combined per direction + mode).
              </li>
              <li style={{ marginBottom: 8 }}>
                <span aria-hidden>🧠</span> <strong>Relative optimizer (days-of-cover)</strong> — Optional guard (terminal
                config) that skips a slot start for a leg when its DoC exceeds <strong>× the cross-customer average</strong>{" "}
                at that hour, so other customers can still book the berth. Set multiplier <strong>0</strong> to disable.
              </li>
              <li style={{ marginBottom: 8 }}>
                <span aria-hidden>⚓</span> <strong>Roundtrip</strong> — If configured, a minimum number of hours must pass
                after the previous visit on that <strong>same leg</strong> (same customer, direction, and mode) ended before
                another start is allowed — not shared across customers.
              </li>
              <li style={{ marginBottom: 8 }}>
                <span aria-hidden>📉</span> <strong>Insufficient inventory</strong> (outbound) — <strong>Fixed band:</strong>{" "}
                the customer&apos;s attributed stock must cover the parcel (MEPS). <strong>Shared shipping / shared
                inventory:</strong> the <strong>terminal pool</strong> must be at least MEPS.
              </li>
              <li style={{ marginBottom: 8 }}>
                <span aria-hidden>⛔</span> <strong>Customer inventory floor</strong> (<strong>shared inventory</strong> only)
                — The <strong>booking customer&apos;s</strong> attributed balance after the move must not go below{" "}
                <strong>−x</strong> tonnes if you set a deficit limit (terminal config).
              </li>
              <li style={{ marginBottom: 8 }}>
                <span aria-hidden>📈</span> <strong>Tank full</strong> (inbound capacity) — <strong>Fixed band:</strong> the
                parcel must fit in that customer&apos;s capacity band. <strong>Shared modes:</strong> the terminal pool plus the
                parcel must not exceed total storage capacity.
              </li>
              <li style={{ marginBottom: 8 }}>
                <span aria-hidden>🚧</span> <strong>Resource occupied</strong> — The visit must fit on a <strong>compatible</strong>{" "}
                resource (ship → large berth, barge → large or small, train → rail), respect <strong>blackouts</strong>, the{" "}
                <strong>minimum gap</strong> between consecutive uses of the same berth, and finish <strong>pre-/post-ops
                included</strong> before the horizon end.
              </li>
            </ul>
            <p style={{ marginBottom: 12, fontSize: 13, color: "#64748b" }}>
              <strong>Other log icons</strong> (active visit, not idle blocks):{" "}
              <span aria-hidden>✅</span> loaded · <span aria-hidden>🔄</span> loading · <span aria-hidden>⏳</span> pre-ops ·{" "}
              <span aria-hidden>🏁</span> post-ops · <span aria-hidden>○</span> idle with all checks passed but no new start
              this hour.
            </p>
            <p style={{ marginBottom: 0, fontSize: 13, color: "#64748b" }}>
              <strong>Run Scheduler</strong> on the Schedule page applies this logic to your current customers and resources.
            </p>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
