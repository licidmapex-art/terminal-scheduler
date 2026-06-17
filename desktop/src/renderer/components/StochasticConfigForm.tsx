import { useEffect, useMemo, useState } from "react";
import type {
  Customer,
  StochasticConfig,
  StochasticDisruptionEvent,
  StochasticLegDelayConfig
} from "../../types";
import { FormLabelWithHelp, HelpPopover } from "./HelpPopover";
import { defaultStochasticConfig, schedulableLegRows } from "../lib/defaultStochasticConfig";
import {
  disruptionEventFieldsFromConfig,
  disruptionEventFromFields,
  flowMultiplierFieldsFromSpec,
  flowMultiplierSpecFromFields,
  type DisruptionEventFields
} from "../lib/disruptionEventFields";
import {
  legDelayConfigFromFields,
  legDelayFieldsFromConfig,
  type LegDelayFields
} from "../lib/legDelayDistribution";
import type { DistributionFields } from "../lib/stochasticDistributionFields";

interface StochasticConfigFormProps {
  value: StochasticConfig;
  onChange: (next: StochasticConfig) => void;
  customers: Customer[];
}

function legRowKey(customerId: string, direction: string, legKey: string | null): string {
  return `${customerId}|${direction}|${legKey ?? ""}`;
}

function delayForLeg(
  legDelays: StochasticLegDelayConfig[],
  customerId: string,
  direction: "inbound" | "outbound",
  legKey: string | null
): StochasticLegDelayConfig | undefined {
  return legDelays.find(
    (l) =>
      l.customerId === customerId &&
      l.direction === direction &&
      (l.legKey ?? null) === legKey
  );
}

function DistributionCells({
  fields,
  onChange,
  placeholders = { min: "0", mode: "—", max: "Off" },
  step = 1,
  disabled = false
}: {
  fields: DistributionFields;
  onChange: (patch: Partial<DistributionFields>) => void;
  placeholders?: { min: string; mode: string; max: string };
  step?: number;
  disabled?: boolean;
}) {
  return (
    <>
      <td>
        <input
          type="number"
          className="form-input stochastic-leg-num"
          min={0}
          step={step}
          placeholder={placeholders.min}
          value={fields.min}
          disabled={disabled}
          onChange={(e) => onChange({ min: e.target.value })}
        />
      </td>
      <td>
        <input
          type="number"
          className="form-input stochastic-leg-num"
          min={0}
          step={step}
          placeholder={placeholders.mode}
          title="Peak of triangular distribution; leave empty for uniform"
          value={fields.mode}
          disabled={disabled}
          onChange={(e) => onChange({ mode: e.target.value })}
        />
      </td>
      <td>
        <input
          type="number"
          className="form-input stochastic-leg-num"
          min={0}
          step={step}
          placeholder={placeholders.max}
          value={fields.max}
          disabled={disabled}
          onChange={(e) => onChange({ max: e.target.value })}
        />
      </td>
    </>
  );
}

export default function StochasticConfigForm({ value, onChange, customers }: StochasticConfigFormProps) {
  const legRows = useMemo(() => schedulableLegRows(customers), [customers]);
  const flowFields = flowMultiplierFieldsFromSpec(value.pipeline.flowMultiplier);
  /** In-progress leg delay inputs — kept while fields are incomplete (not yet valid to persist). */
  const [legDelayDrafts, setLegDelayDrafts] = useState<Record<string, LegDelayFields>>({});

  useEffect(() => {
    setLegDelayDrafts({});
  }, [customers]);

  const legFieldsForRow = (
    customerId: string,
    direction: "inbound" | "outbound",
    legKey: string | null
  ): LegDelayFields => {
    const key = legRowKey(customerId, direction, legKey);
    const draft = legDelayDrafts[key];
    if (draft) return draft;
    const cfg = delayForLeg(value.legDelays, customerId, direction, legKey);
    return legDelayFieldsFromConfig(cfg);
  };

  const setFlowMultiplierFields = (patch: Partial<DistributionFields>) => {
    const next = { ...flowFields, ...patch };
    onChange({
      ...value,
      pipeline: { flowMultiplier: flowMultiplierSpecFromFields(next) }
    });
  };

  const upsertLegDelay = (
    customerId: string,
    direction: "inbound" | "outbound",
    legKey: string | null,
    fields: LegDelayFields
  ) => {
    const key = legRowKey(customerId, direction, legKey);
    setLegDelayDrafts((prev) => ({ ...prev, [key]: fields }));

    const rest = value.legDelays.filter(
      (l) =>
        !(
          l.customerId === customerId &&
          l.direction === direction &&
          (l.legKey ?? null) === legKey
        )
    );
    const cfg = legDelayConfigFromFields(fields, { customerId, direction, legKey });
    if (cfg) rest.push(cfg);
    onChange({ ...value, legDelays: rest });
  };

  const upsertDisruptionEvent = (index: number, fields: DisruptionEventFields) => {
    const cfg = disruptionEventFromFields(fields);
    const events = [...value.immobilisation.events];
    if (cfg) {
      events[index] = cfg;
    } else {
      events.splice(index, 1);
    }
    onChange({ ...value, immobilisation: { events } });
  };

  const addDisruptionEvent = (kind: StochasticDisruptionEvent["kind"]) => {
    const events: StochasticDisruptionEvent[] = [
      ...value.immobilisation.events,
      kind === "pipeline"
        ? {
            kind: "pipeline",
            label: "Pipeline stop",
            occurrenceProbability: 0.15,
            durationHours: { kind: "triangular", min: 2, mode: 6, max: 12 },
            startHourMin: 0,
            startHourMax: 168,
            impact: { kind: "full_stop" }
          }
        : {
            kind: "terminal",
            label: "Terminal immobilised",
            occurrenceProbability: 0.1,
            durationHours: { kind: "triangular", min: 4, mode: 8, max: 16 },
            startHourMin: 24,
            startHourMax: 120,
            impact: { kind: "full_stop" }
          }
    ];
    onChange({ ...value, immobilisation: { events } });
  };

  const removeDisruptionEvent = (index: number) => {
    const events = value.immobilisation.events.filter((_, i) => i !== index);
    onChange({ ...value, immobilisation: { events } });
  };

  const defaults = defaultStochasticConfig();

  return (
    <div className="card config-section stochastic-config-form">
      <div className="config-section-header">
        <span className="config-section-num">1</span>
        <div>
          <div className="config-section-title-row">
            <div className="config-section-title">Scenario parameters</div>
            <HelpPopover
              label="Stochastics help"
              content="Sample arrival delays, pipeline flow variation, and disruption events on replay. The baseline schedule is preserved; use Sample once on the Gantt to preview one scenario."
            />
          </div>
        </div>
      </div>

      <label className="form-check" style={{ marginBottom: 16 }}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <span>Enable stochastic scenarios</span>
      </label>

      {value.enabled && (
        <>
          <div className="form-grid" style={{ marginBottom: 16 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <FormLabelWithHelp help="Optional fixed seed for reproducible samples. Leave blank for a random seed each time.">
                Seed (optional)
              </FormLabelWithHelp>
              <input
                type="number"
                className="form-input"
                min={0}
                step={1}
                placeholder="Random"
                value={value.seed ?? ""}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  onChange({
                    ...value,
                    seed: raw === "" ? undefined : Math.max(0, Math.floor(Number(raw)))
                  });
                }}
              />
            </div>
          </div>

          <div className="form-group">
            <FormLabelWithHelp
              help={
                <>
                  Each simulation hour samples a multiplier on nominal pipeline t/h (1 = nominal).
                  Use min / most likely / max for a triangular distribution, or min + max only for
                  uniform.
                </>
              }
            >
              Pipeline flow variation (hourly multiplier)
            </FormLabelWithHelp>
            <div className="stochastic-dist-block">
              <div className="stochastic-dist-row stochastic-dist-row--labels">
                <span className="stochastic-dist-label">Min</span>
                <span className="stochastic-dist-label">Most likely</span>
                <span className="stochastic-dist-label">Max</span>
              </div>
              <div className="stochastic-dist-row stochastic-dist-row--triple">
                <input
                  type="number"
                  className="form-input stochastic-leg-num"
                  min={0}
                  step={0.05}
                  placeholder={String(
                    defaults.pipeline.flowMultiplier.kind === "triangular"
                      ? defaults.pipeline.flowMultiplier.min
                      : 0.85
                  )}
                  value={flowFields.min}
                  onChange={(e) => setFlowMultiplierFields({ min: e.target.value })}
                />
                <input
                  type="number"
                  className="form-input stochastic-leg-num"
                  min={0}
                  step={0.05}
                  placeholder={String(
                    defaults.pipeline.flowMultiplier.kind === "triangular"
                      ? defaults.pipeline.flowMultiplier.mode
                      : 0.95
                  )}
                  value={flowFields.mode}
                  onChange={(e) => setFlowMultiplierFields({ mode: e.target.value })}
                />
                <input
                  type="number"
                  className="form-input stochastic-leg-num"
                  min={0}
                  step={0.05}
                  placeholder="1"
                  value={flowFields.max}
                  onChange={(e) => setFlowMultiplierFields({ max: e.target.value })}
                />
              </div>
            </div>
          </div>

          {legRows.length > 0 && (
            <div className="form-group">
              <FormLabelWithHelp
                help={
                  <>
                    Each matching slot first rolls against <strong>P(delay)</strong> (0–1). Only if
                    that succeeds is a delay drawn from min / most likely / max.
                  </>
                }
              >
                Arrival delays
              </FormLabelWithHelp>
              <div className="stochastic-leg-table-wrap">
                <table className="data-table stochastic-leg-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Leg</th>
                      <th>P(delay)</th>
                      <th>Min (h)</th>
                      <th>Most likely (h)</th>
                      <th>Max (h)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legRows.map((row) => {
                      const fields = legFieldsForRow(row.customerId, row.direction, row.legKey);
                      const updateFields = (patch: Partial<LegDelayFields>) => {
                        upsertLegDelay(row.customerId, row.direction, row.legKey, {
                          ...fields,
                          ...patch
                        });
                      };
                      return (
                        <tr key={legRowKey(row.customerId, row.direction, row.legKey)}>
                          <td>{row.customerName}</td>
                          <td>
                            {row.direction} · {row.mode}
                            {row.legKey ? ` · ${row.legKey}` : ""}
                          </td>
                          <td>
                            <input
                              type="number"
                              className="form-input stochastic-leg-num"
                              min={0}
                              max={1}
                              step={0.05}
                              placeholder="0.25"
                              value={fields.probability}
                              onChange={(e) => updateFields({ probability: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              className="form-input stochastic-leg-num"
                              min={0}
                              step={1}
                              placeholder="0"
                              value={fields.min}
                              onChange={(e) => updateFields({ min: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              className="form-input stochastic-leg-num"
                              min={0}
                              step={1}
                              placeholder="—"
                              value={fields.mode}
                              onChange={(e) => updateFields({ mode: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              className="form-input stochastic-leg-num"
                              min={0}
                              step={1}
                              placeholder="Off"
                              value={fields.max}
                              onChange={(e) => updateFields({ max: e.target.value })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="form-group" style={{ marginBottom: 0 }}>
            <div className="stochastic-section-heading">
              <FormLabelWithHelp
                help={
                  <>
                    Each event rolls once per simulation period against <strong>P(occurs)</strong>.
                    If it happens, duration is sampled from min / most likely / max and start time
                    falls between the start-from / start-to hours. <strong>Terminal</strong> blocks
                    berths; <strong>Pipeline</strong> applies impact (full stop or partial multiplier)
                    for the event window on top of hourly flow variation.
                  </>
                }
              >
                Disruption events
              </FormLabelWithHelp>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => addDisruptionEvent("terminal")}
                >
                  Add terminal
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => addDisruptionEvent("pipeline")}
                >
                  Add pipeline
                </button>
              </div>
            </div>
            {value.immobilisation.events.length === 0 ? (
              <p className="form-hint" style={{ marginTop: 8 }}>
                No disruption events configured.
              </p>
            ) : (
              <div className="stochastic-leg-table-wrap">
                <table className="data-table stochastic-disruption-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Label</th>
                      <th>P(occurs)</th>
                      <th>Min dur</th>
                      <th>Mode dur</th>
                      <th>Max dur</th>
                      <th>Start from</th>
                      <th>Start to</th>
                      <th>Impact</th>
                      <th>Impact min</th>
                      <th>Impact mode</th>
                      <th>Impact max</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {value.immobilisation.events.map((ev, i) => {
                      const fields = disruptionEventFieldsFromConfig(ev);
                      const update = (patch: Partial<DisruptionEventFields>) => {
                        upsertDisruptionEvent(i, { ...fields, ...patch });
                      };
                      const impactDisabled =
                        fields.kind === "terminal" || fields.impactKind === "full_stop";
                      return (
                        <tr key={i}>
                          <td>
                            <select
                              className="form-input stochastic-disruption-type"
                              value={fields.kind}
                              onChange={(e) =>
                                update({ kind: e.target.value as StochasticDisruptionEvent["kind"] })
                              }
                            >
                              <option value="terminal">Terminal</option>
                              <option value="pipeline">Pipeline</option>
                            </select>
                          </td>
                          <td>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="Label"
                              value={fields.label}
                              onChange={(e) => update({ label: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              className="form-input stochastic-leg-num"
                              min={0}
                              max={1}
                              step={0.05}
                              placeholder="0.1"
                              title="Probability event occurs once per simulation period"
                              value={fields.probability}
                              onChange={(e) => update({ probability: e.target.value })}
                            />
                          </td>
                          <DistributionCells
                            fields={fields.duration}
                            onChange={(patch) =>
                              update({ duration: { ...fields.duration, ...patch } })
                            }
                            placeholders={{ min: "0", mode: "8", max: "24" }}
                          />
                          <td>
                            <input
                              type="number"
                              className="form-input stochastic-leg-num"
                              min={0}
                              step={1}
                              title="Earliest start hour from simulation start"
                              value={fields.startHourMin}
                              onChange={(e) => update({ startHourMin: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              className="form-input stochastic-leg-num"
                              min={1}
                              step={1}
                              title="Latest start hour from simulation start"
                              value={fields.startHourMax}
                              onChange={(e) => update({ startHourMax: e.target.value })}
                            />
                          </td>
                          <td>
                            <select
                              className="form-input"
                              value={fields.impactKind}
                              disabled={fields.kind === "terminal"}
                              title={
                                fields.kind === "terminal"
                                  ? "Terminal events always fully immobilise berths"
                                  : undefined
                              }
                              onChange={(e) =>
                                update({
                                  impactKind: e.target.value as DisruptionEventFields["impactKind"]
                                })
                              }
                            >
                              <option value="full_stop">Full stop</option>
                              <option value="partial">Partial</option>
                            </select>
                          </td>
                          <DistributionCells
                            fields={fields.impact}
                            onChange={(patch) => update({ impact: { ...fields.impact, ...patch } })}
                            placeholders={{ min: "0.5", mode: "0.75", max: "0.9" }}
                            step={0.05}
                            disabled={impactDisabled}
                          />
                          <td>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => removeDisruptionEvent(i)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
