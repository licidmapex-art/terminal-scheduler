import ErrorBoundary from "../components/ErrorBoundary";
import { ConstraintIcon } from "../components/ConstraintIcon";
import TransportStatusIcon from "../components/TransportStatusIcon";
import { Minus } from "lucide-react";
import type { TransportModeStatus } from "../../engine/simulationLog";

function IntroConstraintItem({
  constraintKey,
  children
}: {
  constraintKey: NonNullable<TransportModeStatus["blockingConstraint"]>;
  children: React.ReactNode;
}) {
  return (
    <li style={{ marginBottom: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ marginTop: 2, flexShrink: 0 }}>
        <ConstraintIcon constraintKey={constraintKey} size={16} />
      </span>
      <span>{children}</span>
    </li>
  );
}

function IntroStatusSample({ status }: { status: TransportModeStatus }) {
  return (
    <span style={{ display: "inline-flex", verticalAlign: "middle", margin: "0 2px" }}>
      <TransportStatusIcon status={status} size={14} />
    </span>
  );
}

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
              <strong>Who do constraints apply to?</strong> Most limits are evaluated <strong>per leg</strong> (customer ×
              direction × mode). <strong>Shared shipping</strong> combines pace and annual targets across customers for each
              direction + mode. <strong>Shared inventory</strong> does that for <strong>inbound</strong> only; outbound stays
              per leg. The table below summarises tie-breakers and constraints for each storage mode.
            </p>
            <p style={{ marginBottom: 12 }}>
              <strong>Which leg runs first in that hour?</strong> Active legs are sorted (lower = tried earlier), then the
              scheduler walks the list and assigns the first leg that passes every constraint check.
            </p>
            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>
              Tie-breakers (merit order — sort only, not blocking icons)
            </p>
            <ol style={{ margin: "0 0 12px", paddingLeft: 20 }}>
              <li style={{ marginBottom: 8 }}>
                <strong>Fulfilment ratio</strong> — In <strong>shared shipping</strong> (all legs) and{" "}
                <strong>shared inventory</strong> (inbound only), legs sharing the same direction + mode are ordered by{" "}
                <strong>slots started ÷ that leg&apos;s annual target</strong>. The customer furthest behind their own target
                is tried first. This is a <strong>priority rule</strong>, not a Simulation log icon — but it strongly shapes
                who gets the berth when the pool is open.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Days-of-cover priority score</strong> — When fulfilment ratios tie (or the mode has no pooled rotation),
                the engine uses the DoC score below. <strong>Lower</strong> = tried earlier.
              </li>
              <li style={{ marginBottom: 8 }}>
                <strong>Customer name</strong> — Final tie-break (stable alphabetical order).
              </li>
            </ol>
            <p style={{ marginBottom: 8, fontSize: 13, color: "#64748b" }}>
              Legs are tried in merit order each hour. The scheduler walks the sorted list and assigns the first leg that passes
              every constraint check below.
            </p>
            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>
              DoC priority score (Simulation log tooltips — same as the sort when ratios tie)
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
              Rules by storage mode
            </p>
            <p style={{ marginBottom: 12, fontSize: 13, color: "#64748b" }}>
              <strong>Tie-breakers</strong> decide try order only. <strong>Constraints</strong> can block a slot start and
              appear as icons in the Simulation log when the leg is idle. A leg higher in the queue can still lose the berth
              to a lower leg if it fails a constraint (e.g. tank full on a larger MEPS while a smaller parcel still fits).
            </p>
            <div style={{ overflowX: "auto", marginBottom: 20 }}>
              <table className="data-table intro-rules-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 160 }}>Rule</th>
                    <th style={{ minWidth: 56 }}>Merit order</th>
                    <th style={{ minWidth: 72 }}>Kind</th>
                    <th style={{ minWidth: 120 }}>Fixed band</th>
                    <th style={{ minWidth: 120 }}>Time-shared</th>
                    <th style={{ minWidth: 120 }}>Shared inventory</th>
                    <th style={{ minWidth: 120 }}>Shared shipping</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Fulfilment ratio</td>
                    <td>1st</td>
                    <td>Tie-breaker</td>
                    <td>—</td>
                    <td>—</td>
                    <td>Inbound only (pooled by direction + mode)</td>
                    <td>All legs (pooled by direction + mode)</td>
                  </tr>
                  <tr>
                    <td>DoC priority score</td>
                    <td>2nd</td>
                    <td>Tie-breaker</td>
                    <td>Per customer inventory</td>
                    <td>Per customer inventory</td>
                    <td>Per customer inventory</td>
                    <td>Terminal pool share</td>
                  </tr>
                  <tr>
                    <td>Customer name</td>
                    <td>3rd</td>
                    <td>Tie-breaker</td>
                    <td>Yes</td>
                    <td>Yes</td>
                    <td>Yes</td>
                    <td>Yes</td>
                  </tr>
                  <tr>
                    <td>Annual target met</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td>Per leg</td>
                    <td>Per leg</td>
                    <td>Per leg; inbound also shares combined pace pool</td>
                    <td>Per leg + combined pool cap</td>
                  </tr>
                  <tr>
                    <td>Pace ahead</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td>Per leg</td>
                    <td>Per leg</td>
                    <td>Inbound combined; outbound per leg</td>
                    <td>Combined per direction + mode</td>
                  </tr>
                  <tr>
                    <td>Relative optimizer (DoC)</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td colSpan={4}>Optional (terminal config). Same check in all modes when enabled.</td>
                  </tr>
                  <tr>
                    <td>Relative optimizer (fulfilment)</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td>—</td>
                    <td>—</td>
                    <td>Inbound pool only</td>
                    <td>All legs (pooled by direction + mode)</td>
                  </tr>
                  <tr>
                    <td>Roundtrip</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td colSpan={4}>Per leg (same customer, direction, mode). Same in all modes.</td>
                  </tr>
                  <tr>
                    <td>Insufficient inventory</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td>Customer stock</td>
                    <td>Customer stock</td>
                    <td>Terminal pool</td>
                    <td>Terminal pool</td>
                  </tr>
                  <tr>
                    <td>Customer inventory floor</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td>—</td>
                    <td>—</td>
                    <td>Outbound only (booking customer −x limit)</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>Tank full</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td>Customer band</td>
                    <td>Customer band</td>
                    <td>Terminal capacity</td>
                    <td>Terminal capacity</td>
                  </tr>
                  <tr>
                    <td>Resource occupied</td>
                    <td>—</td>
                    <td>Constraint</td>
                    <td colSpan={4}>Compatible berth/rail, blackouts, min gap, horizon end. Same in all modes.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>
              Constraints (icons match the Simulation log when a leg is idle with that block)
            </p>
            <ul style={{ margin: "0 0 12px", paddingLeft: 0, listStyle: "none" }}>
              <IntroConstraintItem constraintKey="annual_target_met">
                <strong>Annual target met</strong> — That leg has reached its computed slot target from declared throughput
                and MEPS (and roundtrip limits). Under <strong>shared shipping</strong> or <strong>shared inventory</strong>{" "}
                inbound, a customer can hit this while the combined pool still has spare capacity for others.
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="pace_ahead">
                <strong>Pace ahead</strong> — Slot starts are throttled so visits are spread across the horizon, not only
                bunched at the beginning (continuous pace target <strong>per leg</strong>, except{" "}
                <strong>shared shipping</strong> where pace is combined per direction + mode).
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="optimizer_days_of_cover">
                <strong>Relative optimizer (days-of-cover)</strong> — Optional guard (terminal config) that skips a slot start
                for a leg when its DoC exceeds <strong>× the cross-customer average</strong> at that hour, so other customers
                can still book the berth. Set multiplier <strong>0</strong> to disable.
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="optimizer_fulfillment">
                <strong>Relative optimizer (fulfilment)</strong> — Optional guard (terminal config) in{" "}
                <strong>shared shipping</strong> and <strong>shared inventory</strong> inbound pools: skips a slot start when
                this leg&apos;s annual fulfilment % exceeds <strong>× the pool average</strong> for that direction + mode.
                Reduces streaks when a customer is ahead on ship quota. Set multiplier <strong>0</strong> to disable.
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="roundtrip">
                <strong>Roundtrip</strong> — If configured, a minimum number of hours must pass after the previous visit on
                that <strong>same leg</strong> (same customer, direction, and mode) ended before another start is allowed — not
                shared across customers.
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="insufficient_inventory">
                <strong>Insufficient inventory</strong> (outbound) — <strong>Fixed band:</strong> the customer&apos;s
                attributed stock must cover the parcel (MEPS). <strong>Shared shipping / shared inventory:</strong> the{" "}
                <strong>terminal pool</strong> must be at least MEPS.
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="customer_inventory_floor">
                <strong>Customer inventory floor</strong> (<strong>shared inventory</strong> only) — The{" "}
                <strong>booking customer&apos;s</strong> attributed balance after the move must not go below{" "}
                <strong>−x</strong> tonnes if you set a deficit limit (terminal config).
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="tank_full">
                <strong>Tank full</strong> (inbound capacity) — <strong>Fixed band:</strong> the parcel must fit in that
                customer&apos;s capacity band. <strong>Shared modes:</strong> the terminal pool plus the parcel must not exceed
                total storage capacity.
              </IntroConstraintItem>
              <IntroConstraintItem constraintKey="resource_occupied">
                <strong>Resource occupied</strong> — The visit must fit on a <strong>compatible</strong> resource (ship → large
                berth, barge → large or small, train → rail), respect <strong>blackouts</strong>, the <strong>minimum gap</strong>{" "}
                between consecutive uses of the same berth, and finish <strong>pre-/post-ops included</strong> before the horizon
                end.
              </IntroConstraintItem>
            </ul>
            <p style={{ marginBottom: 12, fontSize: 13, color: "#64748b", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <strong>Other log icons</strong> (active visit, not idle blocks):
              <IntroStatusSample status={{ action: "loaded", customerId: "", direction: "inbound", mode: "ship" }} />
              loaded
              <IntroStatusSample status={{ action: "loading_in_progress", customerId: "", direction: "inbound", mode: "ship" }} />
              loading
              <IntroStatusSample status={{ action: "pre_ops", customerId: "", direction: "inbound", mode: "ship" }} />
              pre-ops
              <IntroStatusSample status={{ action: "post_ops", customerId: "", direction: "inbound", mode: "ship" }} />
              post-ops
              <Minus size={14} color="#cbd5e1" strokeWidth={2} aria-hidden />
              idle with all checks passed but no new start this hour.
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
