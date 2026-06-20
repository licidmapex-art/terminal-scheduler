import type { AnalyticsAiSummary } from "./buildAnalyticsAiSummary";
import { remediationForConstraintLabel } from "./schedulingKnowledgeForAi";

export interface AiDiagnosticFinding {
  severity: "high" | "medium" | "low";
  category: string;
  finding: string;
  evidence: string;
  likelyCause: string;
  suggestedFix: string;
  relatedCustomers?: string[];
}

export interface AiDiagnostics {
  rankedFindings: AiDiagnosticFinding[];
  topBlockingConstraints: Array<{ label: string; idleLegHours: number; remediation: string }>;
}

function pushFinding(
  list: AiDiagnosticFinding[],
  item: AiDiagnosticFinding
): void {
  list.push(item);
}

export function buildAiDiagnostics(summary: AnalyticsAiSummary): AiDiagnostics {
  const findings: AiDiagnosticFinding[] = [];
  const { simulation, customers, constraintBlockHoursByType, resources, totals } = summary;

  const topConstraints = Object.entries(constraintBlockHoursByType)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, idleLegHours]) => ({
      label,
      idleLegHours,
      remediation: remediationForConstraintLabel(label)
    }));

  if (topConstraints.length > 0) {
    const top = topConstraints[0]!;
    pushFinding(findings, {
      severity: top.idleLegHours >= 50 ? "high" : "medium",
      category: "Scheduler blocking",
      finding: `Primary bottleneck: ${top.label}`,
      evidence: `${top.idleLegHours} idle leg-hours (top constraint)`,
      likelyCause: top.remediation.split(".")[0] ?? top.label,
      suggestedFix: top.remediation
    });
  }

  if (!totals.throughputAllPass) {
    const failing = customers.filter((c) => !c.throughputPasses);
    pushFinding(findings, {
      severity: "high",
      category: "Throughput coverage",
      finding: "Inbound throughput target not fully scheduled",
      evidence: `${failing.length} customer(s) below 100% scheduled/target inbound tonnes`,
      likelyCause:
        "Slot starts blocked by constraints (roundtrip, tank full, resource occupied, pacing) or insufficient transport configuration (MEPS, roundtrip hours, declared throughput)",
      suggestedFix:
        "Inspect simulation log constraints for failing customers; increase MEPS or reduce roundtrip hours; relax pacing/optimizer; add berth capacity",
      relatedCustomers: failing.map((c) => c.name)
    });
  }

  for (const c of customers) {
    const custConstraints = summary.constraintBlockHoursByCustomer[c.name] ?? {};
    const topCust = Object.entries(custConstraints)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])[0];

    if (c.inboundSlotsTarget > 0 && c.inboundSlotsScheduled < c.inboundSlotsTarget * 0.9) {
      pushFinding(findings, {
        severity: "high",
        category: "Slot count",
        finding: `${c.name}: too few inbound slots`,
        evidence: `${c.inboundSlotsScheduled} scheduled vs ${c.inboundSlotsTarget} target slots`,
        likelyCause: topCust
          ? `Often ${topCust[0]} (${topCust[1]} idle leg-hours on this customer)`
          : "Transport leg blocked repeatedly or roundtrip spacing too wide",
        suggestedFix:
          "Reduce roundtrip hours, increase MEPS, add berth capacity, or relax pacing/optimizer caps",
        relatedCustomers: [c.name]
      });
    }

    if (c.outboundSlotsTarget > 0 && c.outboundSlotsScheduled < c.outboundSlotsTarget * 0.9) {
      pushFinding(findings, {
        severity: "medium",
        category: "Slot count",
        finding: `${c.name}: too few outbound slots`,
        evidence: `${c.outboundSlotsScheduled} scheduled vs ${c.outboundSlotsTarget} target slots`,
        likelyCause:
          topCust?.[0] === "Insufficient inventory"
            ? "Stock too low for outbound MEPS"
            : topCust
              ? `${topCust[0]} blocking outbound starts`
              : "Outbound pressure vs inventory imbalance",
        suggestedFix:
          "Raise starting inventory or inbound pipeline; lower outbound MEPS; fix insufficient inventory / floor blocks",
        relatedCustomers: [c.name]
      });
    }

    if (c.refusedAtTopTonnes > 0 || c.tankTopHours >= 24) {
      pushFinding(findings, {
        severity: c.refusedAtTopTonnes > 0 ? "high" : "medium",
        category: "Storage capacity",
        finding: `${c.name}: tank topped out during simulation`,
        evidence: `${c.tankTopHours} h at/near max${c.refusedAtTopTonnes > 0 ? `; ${Math.round(c.refusedAtTopTonnes)} t inbound refused` : ""}${c.capacityBandT ? `; band ~${Math.round(c.capacityBandT)} t` : ""}`,
        likelyCause: "Inbound exceeds outbound drain — storage band or terminal pool too small",
        suggestedFix:
          "Increase storage share or total terminal capacity; reduce inbound pipeline; schedule more outbound lifts",
        relatedCustomers: [c.name]
      });
    }

    if (c.refusedAtBottomTonnes > 0 || (c.minInventoryT <= 0 && c.outboundTonnes > 0)) {
      pushFinding(findings, {
        severity: c.refusedAtBottomTonnes > 0 ? "high" : "medium",
        category: "Inventory low",
        finding: `${c.name}: inventory ran critically low`,
        evidence: `min ${Math.round(c.minInventoryT)} t; ${Math.round(c.outboundTonnes)} t outbound moved${c.refusedAtBottomTonnes > 0 ? `; ${Math.round(c.refusedAtBottomTonnes)} t outbound refused` : ""}`,
        likelyCause: "Starting stock or inbound supply insufficient for outbound MEPS / targets",
        suggestedFix:
          "Raise starting inventory; increase inbound throughput, pipeline, or slot count; reduce outbound MEPS",
        relatedCustomers: [c.name]
      });
    }

    if (c.partialInboundSlots > 0 || c.partialOutboundSlots > 0) {
      pushFinding(findings, {
        severity: "low",
        category: "Partial loads",
        finding: `${c.name}: partial berth loads (volume < MEPS)`,
        evidence: `${c.partialInboundSlots} inbound, ${c.partialOutboundSlots} outbound partial slot(s)`,
        likelyCause: "Manual slot edits, horizon end clipping, or berth flow rate limiting parcel size",
        suggestedFix: "Review Schedule manual edits; check berth flow rate vs MEPS; extend horizon if end-clipped",
        relatedCustomers: [c.name]
      });
    }

    if (
      c.inboundRoundtripH > 0 &&
      c.inboundSlotsScheduled > 0 &&
      topCust?.[0] === "Roundtrip" &&
      (topCust[1] ?? 0) >= 10
    ) {
      pushFinding(findings, {
        severity: "medium",
        category: "Roundtrip spacing",
        finding: `${c.name}: roundtrip gap limits visit frequency`,
        evidence: `${c.inboundRoundtripH} h roundtrip; ${topCust[1]} roundtrip-blocked idle leg-hours`,
        likelyCause: "Roundtrip hours too long relative to slot target and simulation period",
        suggestedFix: "Lower inbound roundtrip hours or reduce slot target / raise MEPS per visit",
        relatedCustomers: [c.name]
      });
    }

    if (c.daysOfCoverFinalD != null && c.daysOfCoverFinalD < 3 && c.outboundTonnes > 0) {
      pushFinding(findings, {
        severity: "medium",
        category: "Days of cover",
        finding: `${c.name}: very low days of cover at period end`,
        evidence: `Final DoC ≈ ${c.daysOfCoverFinalD} d; final inventory ${Math.round(c.finalInventoryT)} t`,
        likelyCause: "Outbound draw exceeds inbound replenishment",
        suggestedFix: "Increase inbound slots/pipeline or reduce outbound pressure; review starting inventory",
        relatedCustomers: [c.name]
      });
    }
  }

  const hotBerth = resources
    .filter((r) => r.type?.startsWith("berth") || r.type === "rail")
    .sort((a, b) => b.utilizationPct - a.utilizationPct)[0];
  if (hotBerth && hotBerth.utilizationPct >= 75) {
    pushFinding(findings, {
      severity: hotBerth.utilizationPct >= 90 ? "high" : "medium",
      category: "Berth utilization",
      finding: `Berth/rail capacity tight: ${hotBerth.name}`,
      evidence: `${hotBerth.utilizationPct}% utilization; ${hotBerth.slots} slots; ${Math.round(hotBerth.hoursOnBerth)} h occupied`,
      likelyCause: "Resource occupied blocks dominate when utilization is high",
      suggestedFix:
        "Add compatible berth/rail, reduce laytime, widen blackouts, or spread visits (roundtrip/pacing)",
      relatedCustomers: []
    });
  }

  if (simulation.totalStorageCapacityT > 0) {
    const peakTerminal = customers.reduce((s, c) => s + c.maxInventoryT, 0);
    const utilPct = (peakTerminal / simulation.totalStorageCapacityT) * 100;
    if (utilPct >= 95) {
      pushFinding(findings, {
        severity: "high",
        category: "Terminal storage",
        finding: "Terminal storage nearly full at peak",
        evidence: `Peak attributed inventory ~${Math.round(peakTerminal)} t vs ${Math.round(simulation.totalStorageCapacityT)} t capacity (${Math.round(utilPct)}%)`,
        likelyCause: "Aggregate inbound exceeds outbound across customers",
        suggestedFix: "Increase total storage capacity or shift volume outbound; check shared vs individual mode",
        relatedCustomers: []
      });
    }
  }

  for (const w of summary.feasibilityWarnings.slice(0, 5)) {
    const text = typeof w === "string" ? w : String(w);
    pushFinding(findings, {
      severity: "medium",
      category: "Feasibility warning",
      finding: text.slice(0, 120),
      evidence: "Post-run feasibility check",
      likelyCause: "Schedule or inventory violates configured limits",
      suggestedFix: "Open Schedule feasibility warnings and adjust config or slots"
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    rankedFindings: findings.slice(0, 12),
    topBlockingConstraints: topConstraints
  };
}
