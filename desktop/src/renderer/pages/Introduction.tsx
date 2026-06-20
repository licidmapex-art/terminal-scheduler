import { useState } from "react";
import ErrorBoundary from "../components/ErrorBoundary";
import { PageTitleWithHelp } from "../components/HelpPopover";
import { ConstraintIcon } from "../components/ConstraintIcon";
import TransportStatusIcon from "../components/TransportStatusIcon";
import { Minus } from "lucide-react";
import type { TransportModeStatus } from "../../engine/simulationLog";
import type { BlockingConstraintKey } from "../lib/schedulingConstraints";
import type { StorageMode } from "../../types";

function IntroConstraintItem({
  constraintKey,
  children
}: {
  constraintKey: BlockingConstraintKey;
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

const MODES: { key: StorageMode; title: string; tagline: string }[] = [
  {
    key: "fixed_band",
    title: "Individual",
    tagline: "Dedicated customer storage bands"
  },
  {
    key: "shared_inventory",
    title: "Shared",
    tagline: "Shared terminal pool (borrowing rules / pooled fairness)"
  }
];

function isShared(mode: StorageMode): boolean {
  return mode === "shared_inventory";
}

/** One-paragraph "who do constraints apply to?" summary per mode. */
function scopeForMode(mode: StorageMode): React.ReactNode {
  switch (mode) {
    case "fixed_band":
      return (
        <>
          Every limit is evaluated <strong>per leg</strong> (customer × direction × mode). Each customer owns a{" "}
          <strong>dedicated capacity band</strong> (storage share × total), and inventory gates use that customer&apos;s
          own attributed stock. There is no pooled rotation, so the days-of-cover score is the primary sort.
        </>
      );
    case "shared_inventory":
      return (
        <>
          Inventory gates use one <strong>terminal-wide pool</strong>, but a berth move attributes{" "}
          <strong>100% of its volume to the booking customer</strong> (not proportional). <strong>Inbound</strong> berth
          pace and annual targets are <strong>pooled across customers by transport mode</strong> so early-year slots
          rotate fairly; <strong>outbound</strong> stays per leg. An optional <strong>−x deficit floor</strong> protects
          the booking customer&apos;s attributed balance on outbound moves.
        </>
      );
  }
}

interface TieBreaker {
  label: string;
  note: string;
  active: boolean;
}

function tieBreakersForMode(mode: StorageMode): TieBreaker[] {
  const fulfilment: TieBreaker = {
    label: "Mass fulfilment",
    active: isShared(mode),
    note: isShared(mode)
      ? "Active for inbound only — inbound legs pooled by mode are ordered by mass fulfilment; outbound falls through to the DoC score."
      : "Not used — there is no pooled rotation in this mode, so the DoC score is the primary sort."
  };
  const doc: TieBreaker = {
    label: "Days-of-cover (DoC) priority score",
    active: true,
    note:
      "Uses each customer's own attributed inventory versus the opposite-direction pressure. Lower = tried earlier."
  };
  const name: TieBreaker = {
    label: "Customer name",
    active: true,
    note: "Final stable tie-break (alphabetical). Same in every mode."
  };
  return [fulfilment, doc, name];
}

interface Gate {
  constraintKey: BlockingConstraintKey;
  /** The check phrased so that "yes" continues down the tree. */
  question: string;
  blockedLabel: string;
  /** Mode-specific scope shown under the gate and in the reference list. */
  scope: string;
}

function gatesForMode(mode: StorageMode): Gate[] {
  const shared = isShared(mode);
  const gates: Gate[] = [
    {
      constraintKey: "annual_target_met",
      question: "Still under the leg's annual slot target?",
      blockedLabel: "Annual target met",
      scope: shared
        ? "Per leg; inbound also shares a combined pace pool by mode."
        : "Per leg (customer × direction × mode)."
    },
    {
      constraintKey: "pace_ahead",
      question: "On or behind the spread-out pace?",
      blockedLabel: "Pace ahead",
      scope: shared ? "Inbound pace combined by mode; outbound per leg." : "Per leg."
    },
    {
      constraintKey: "optimizer_days_of_cover",
      question: "Below the days-of-cover optimizer cap? (if enabled)",
      blockedLabel: "Relative optimizer (DoC)",
      scope: "Optional terminal guard. Same check in every mode; multiplier 0 disables it."
    }
  ];

  if (shared) {
    gates.push({
      constraintKey: "optimizer_fulfillment",
      question: "Below the fulfilment optimizer cap? (if enabled)",
      blockedLabel: "Relative optimizer (fulfilment)",
      scope: "Inbound pool only."
    });
  }

  gates.push(
    {
      constraintKey: "roundtrip",
      question: "Has the roundtrip gap since the last visit elapsed?",
      blockedLabel: "Roundtrip",
      scope: "Per leg (same customer, direction, mode). Same in every mode."
    },
    {
      constraintKey: "insufficient_inventory",
      question: "Enough inventory to cover the parcel (MEPS)? (outbound)",
      blockedLabel: "Insufficient inventory",
      scope: shared
        ? "Checked against the terminal pool (≥ MEPS)."
        : "Checked against the customer's attributed stock (≥ MEPS)."
    }
  );

  if (mode === "shared_inventory") {
    gates.push({
      constraintKey: "customer_inventory_floor",
      question: "Does the booking customer stay above its −x floor? (outbound)",
      blockedLabel: "Customer inventory floor",
      scope: "Shared inventory only: the booking customer's attributed balance can't drop below −x tonnes."
    });
  }

  gates.push(
    {
      constraintKey: "tank_full",
      question: "Room for the parcel? (inbound)",
      blockedLabel: "Tank full",
      scope: shared
        ? "Terminal pool + parcel must fit total storage capacity."
        : "Parcel must fit the customer's own capacity band."
    },
    {
      constraintKey: "resource_occupied",
      question: "Is a compatible berth/rail free? (blackouts, min gap, horizon)",
      blockedLabel: "Resource occupied",
      scope: "Compatible resource, blackouts, min gap, and pre-/post-ops before the horizon end. Same in every mode."
    }
  );

  return gates;
}

/** Mode-agnostic explanation for each constraint (the "In this mode" note is appended per mode). */
const CONSTRAINT_DESCRIPTIONS: Record<BlockingConstraintKey, React.ReactNode> = {
  annual_target_met: (
    <>
      <strong>Annual target met</strong> — the leg has reached its computed slot target from declared throughput and MEPS
      (and roundtrip limits).
    </>
  ),
  pace_ahead: (
    <>
      <strong>Pace ahead</strong> — slot starts are throttled so visits spread across the horizon instead of bunching at
      the start.
    </>
  ),
  optimizer_days_of_cover: (
    <>
      <strong>Relative optimizer (days-of-cover)</strong> — optional guard that skips a start when a leg&apos;s DoC
      exceeds <strong>× combined terminal DoC</strong> that hour, so others can book the berth.
    </>
  ),
  optimizer_fulfillment: (
    <>
      <strong>Relative optimizer (fulfilment)</strong> — optional guard that skips a start when a leg&apos;s delivered
      tonnes ÷ target tonnes exceeds <strong>× the pool average</strong> for its direction + mode.
    </>
  ),
  roundtrip: (
    <>
      <strong>Roundtrip</strong> — a minimum number of hours from one visit <strong>start</strong> (pre-ops) to
      the next start on the <strong>same leg</strong> (start-to-start, not from berth release).
    </>
  ),
  insufficient_inventory: (
    <>
      <strong>Insufficient inventory</strong> (outbound) — there must be enough inventory to cover the parcel (MEPS)
      before a load-out can start.
    </>
  ),
  customer_inventory_floor: (
    <>
      <strong>Customer inventory floor</strong> — the booking customer&apos;s attributed balance after the move must not
      drop below <strong>−x</strong> tonnes (if a deficit limit is set).
    </>
  ),
  tank_full: (
    <>
      <strong>Tank full</strong> (inbound capacity) — the incoming parcel must fit available storage.
    </>
  ),
  resource_occupied: (
    <>
      <strong>Resource occupied</strong> — the visit must fit a <strong>compatible</strong> resource (ship → large
      berth, barge → large or small, train → rail), respect <strong>blackouts</strong>, the{" "}
      <strong>minimum gap</strong> between uses, and finish <strong>pre-/post-ops included</strong> before the horizon
      end.
    </>
  )
};

function DecisionTree({ gates }: { gates: Gate[] }) {
  return (
    <div className="decision-tree" role="img" aria-label="Decision tree for when a slot is scheduled">
      <div className="dt-step">
        <div className="dt-row dt-row-single">
          <div className="dt-node dt-start">New simulation hour</div>
        </div>
        <div className="dt-arrow" />
        <div className="dt-row dt-row-single">
          <div className="dt-node dt-process">
            Update inventory — pipeline + cargo already moving on berths (incl. pre-/post-ops laytime)
          </div>
        </div>
        <div className="dt-arrow" />
        <div className="dt-row dt-row-single">
          <div className="dt-node dt-process">Sort active legs into merit order (tie-breakers above)</div>
        </div>
        <div className="dt-arrow" />
        <div className="dt-row dt-row-single">
          <div className="dt-node dt-process">Take the next leg in the queue</div>
        </div>
      </div>

      {gates.map((gate) => (
        <div key={gate.constraintKey} className="dt-step" style={{ width: "100%" }}>
          <div className="dt-arrow">
            <span className="dt-yes">yes</span>
          </div>
          <div className="dt-row">
            <div className="dt-node dt-gate">
              <div className="dt-gate-q">{gate.question}</div>
              <div className="dt-gate-scope">{gate.scope}</div>
            </div>
            <div className="dt-fail-wrap">
              <span className="dt-fail-connector" aria-hidden />
              <span className="dt-fail-link">no &rarr;</span>
              <div className="dt-fail">
                <ConstraintIcon constraintKey={gate.constraintKey} size={14} />
                <span>Skip · {gate.blockedLabel}</span>
              </div>
            </div>
          </div>
        </div>
      ))}

      <div className="dt-step">
        <div className="dt-arrow dt-arrow-pass">
          <span className="dt-yes">all pass</span>
        </div>
        <div className="dt-row dt-row-single">
          <div className="dt-node dt-schedule">Start load — slot scheduled for this leg</div>
        </div>
      </div>
      <div className="dt-foot">
        Then the scheduler keeps walking the queue: other legs (different customers or directions) can still start in the
        same hour. At most <strong>one new load start per leg per hour</strong>.
      </div>
    </div>
  );
}

export default function Introduction() {
  const [mode, setMode] = useState<StorageMode>("fixed_band");
  const gates = gatesForMode(mode);
  const tieBreakers = tieBreakersForMode(mode);
  const activeMode = MODES.find((m) => m.key === mode)!;

  return (
    <ErrorBoundary>
      <div>
        <div className="page-header">
          <div>
            <PageTitleWithHelp
              title="Introduction"
              help="How the hour-by-hour scheduler works: legs, pacing, inventory, and Simulation log icons."
            />
            <p className="page-subtitle">
              How the hour-by-hour scheduler works: legs, pacing, inventory, and how Simulation log icons line up with
              engine rules.
            </p>
          </div>
        </div>

        <div className="card mb-24">
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
              The scheduler runs a single <strong>forward pass</strong> over the simulation horizon,{" "}
              <strong>hour by hour</strong>. At the start of each hour it updates inventory from the{" "}
              <strong>pipeline</strong> and from <strong>cargo already moving</strong> on berths (including your
              pre-/post-ops laytime). It then tries to <strong>start at most one new load start</strong> per customer{" "}
              <strong>transport leg</strong> (customer + inbound/outbound + ship/barge/train). Different legs can still
              start in the same hour. Each attempt is subject to the constraints below.
            </p>

            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>Pick a storage mode</p>
            <p className="text-muted-sm" style={{ marginBottom: 10 }}>
              The merit order and constraints below adapt to the selected allocation mode (set on the Schedule page).
            </p>
            <div className="intro-mode-tabs" role="tablist" aria-label="Storage mode">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.key}
                  className={`intro-mode-tab${mode === m.key ? " selected" : ""}`}
                  onClick={() => setMode(m.key)}
                >
                  <div className="intro-mode-tab-title">{m.title}</div>
                  <div className="intro-mode-tab-tag">{m.tagline}</div>
                </button>
              ))}
            </div>

            <p style={{ marginBottom: 4, fontWeight: 600, color: "#334155" }}>
              {activeMode.title}: who do constraints apply to?
            </p>
            <p style={{ marginTop: 0, marginBottom: 16 }}>{scopeForMode(mode)}</p>

            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>
              Merit order — which leg is tried first (sort only, not a block)
            </p>
            <ol style={{ margin: "0 0 8px", paddingLeft: 20 }}>
              {tieBreakers.map((tb) => (
                <li key={tb.label} style={{ marginBottom: 8, opacity: tb.active ? 1 : 0.6 }}>
                  <strong>{tb.label}</strong>
                  {!tb.active && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#94a3b8",
                        marginLeft: 8,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em"
                      }}
                    >
                      not used here
                    </span>
                  )}
                  <span style={{ display: "block", fontSize: 13, color: "#64748b", marginTop: 2 }}>{tb.note}</span>
                </li>
              ))}
            </ol>
            <p style={{ marginBottom: 16, fontSize: 13, color: "#64748b" }}>
              The scheduler walks the sorted list and assigns the berth to the first leg that passes every check in the
              tree below. A leg higher in the queue can still lose the berth to a lower one if it fails a check (e.g. tank
              full on a larger MEPS while a smaller parcel still fits).
            </p>

            <p style={{ marginBottom: 4, fontWeight: 600, color: "#334155" }}>
              When is a slot scheduled? ({activeMode.title})
            </p>
            <p style={{ marginBottom: 12, fontSize: 13, color: "#64748b" }}>
              For each leg in merit order, the engine runs these checks top to bottom. Any failed check skips the leg for
              this hour and shows the matching icon in the Simulation log; passing every check starts the load.
            </p>
            <DecisionTree gates={gates} />

            <p style={{ marginBottom: 8, fontWeight: 600, color: "#334155" }}>
              Constraint reference ({activeMode.title})
            </p>
            <p style={{ marginBottom: 8, fontSize: 13, color: "#64748b" }}>
              Icons match the Simulation log when a leg is idle with that block.
            </p>
            <ul style={{ margin: "0 0 16px", paddingLeft: 0, listStyle: "none" }}>
              {gates.map((gate) => (
                <IntroConstraintItem key={gate.constraintKey} constraintKey={gate.constraintKey}>
                  {CONSTRAINT_DESCRIPTIONS[gate.constraintKey]}{" "}
                  <span style={{ color: "#64748b" }}>
                    <em>In this mode:</em> {gate.scope}
                  </span>
                </IntroConstraintItem>
              ))}
            </ul>

            <details style={{ marginBottom: 16 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600, color: "#334155" }}>
                How the days-of-cover (DoC) priority score is computed
              </summary>
              <div style={{ marginTop: 10 }}>
                <p style={{ marginBottom: 12 }}>
                  <strong>Inbound legs.</strong> The engine compares each customer&apos;s{" "}
                  <strong>attributed inventory</strong> to the{" "}
                  <strong>total rate at which that customer is expected to ship out</strong> inventory: outbound pipeline
                  (t/d) <strong>plus</strong> scheduled outbound lift spread{" "}
                  <code style={{ fontSize: 13 }}>(outbound targetSlots × outbound MEPS) / horizon days</code>. Score ={" "}
                  <strong>inventory ÷ outbound pressure</strong>. Lower means stock runs short sooner, so that leg is
                  prioritised for inbound cargo.
                </p>
                <p style={{ marginBottom: 12 }}>
                  <strong>Outbound legs.</strong> The score uses <strong>headroom</strong> (max capacity − current
                  inventory) versus the <strong>total rate inventory is expected to arrive</strong>: inbound pipeline
                  (t/d) <strong>plus</strong> scheduled inbound lift spread. Score ={" "}
                  <strong>headroom ÷ inbound fill</strong>. Lower means the tank tops out sooner, so those legs run first
                  to make room. With no inbound fill it falls back to <strong>raw headroom</strong> (fullest tanks
                  first).
                </p>
                <p style={{ marginBottom: 0, fontSize: 13, color: "#64748b" }}>
                  <strong>Analytics summary DoC</strong> (when shown) takes the <strong>minimum</strong> of the two
                  ratios above when both apply — whichever bottleneck is tightest.
                </p>
              </div>
            </details>

            <p
              style={{
                marginBottom: 12,
                fontSize: 13,
                color: "#64748b",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8
              }}
            >
              <strong>Other log icons</strong> (active visit, not idle blocks):
              <IntroStatusSample status={{ action: "loaded", customerId: "", direction: "inbound", mode: "ship" }} />
              loaded
              <IntroStatusSample
                status={{ action: "loading_in_progress", customerId: "", direction: "inbound", mode: "ship" }}
              />
              loading
              <IntroStatusSample status={{ action: "pre_ops", customerId: "", direction: "inbound", mode: "ship" }} />
              pre-ops
              <IntroStatusSample status={{ action: "post_ops", customerId: "", direction: "inbound", mode: "ship" }} />
              post-ops
              <Minus size={14} color="#cbd5e1" strokeWidth={2} aria-hidden />
              idle with all checks passed but no new start this hour.
            </p>
            <p style={{ marginBottom: 0, fontSize: 13, color: "#64748b" }}>
              <strong>Run Scheduler</strong> on the Schedule page applies this logic to your current customers and
              resources.
            </p>
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
