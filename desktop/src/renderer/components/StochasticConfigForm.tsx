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
import { formatHourAsPeriodPercent } from "../lib/stochasticFormUnits";
import type { ReactNode } from "react";

interface StochasticConfigFormProps {
  value: StochasticConfig;
  onChange: (next: StochasticConfig) => void;
  customers: Customer[];
  /** Simulation horizon in whole hours (from terminal config dates). */
  simulationPeriodHours?: number;
  /** Optional actions (e.g. save) shown top-right in the card header. */
  headerActions?: ReactNode;
}

function legRowKey(customerId: string, direction: string, legKey: string | null): string {
  return `${customerId}|${direction}|${legKey ?? ""}`;
}

function MultilineTh({ lines }: { lines: [string, string] | [string] }) {
  return (
    <th className="stochastic-th-multiline">
      {lines.map((line) => (
        <span key={line} className="stochastic-th-line">
          {line}
        </span>
      ))}
    </th>
  );
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

function TableFieldCell({
  children,
  hint
}: {
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="stochastic-table-field-cell">
      {children}
      <span className="stochastic-period-pct">{hint || "\u00a0"}</span>
    </div>
  );
}

function ProbabilityInput({
  value,
  onChange,
  placeholder = "25",
  title
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  title?: string;
}) {
  return (
    <TableFieldCell>
      <div className="stochastic-probability-cell">
        <input
          type="number"
          className="form-input stochastic-leg-num"
          min={0}
          max={100}
          step={0.5}
          placeholder={placeholder}
          title={title}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="stochastic-input-suffix" aria-hidden>
          %
        </span>
      </div>
    </TableFieldCell>
  );
}

function HourInputWithPeriodHint({
  value,
  onChange,
  simulationPeriodHours = 0,
  min,
  step = 1,
  placeholder,
  title,
  disabled = false
}: {
  value: string;
  onChange: (next: string) => void;
  simulationPeriodHours?: number;
  min?: number;
  step?: number;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}) {
  const raw = value.trim();
  const hours = raw === "" ? NaN : Number(raw);
  const periodHint =
    simulationPeriodHours > 0 && Number.isFinite(hours)
      ? formatHourAsPeriodPercent(hours, simulationPeriodHours)
      : "";

  return (
    <TableFieldCell hint={periodHint}>
      <input
        type="number"
        className="form-input stochastic-leg-num"
        {...(min != null ? { min } : {})}
        step={step}
        placeholder={placeholder}
        title={title}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </TableFieldCell>
  );
}

function DistributionCells({
  fields,
  onChange,
  placeholders = { min: "0", mode: "—", max: "Off" },
  step = 1,
  disabled = false,
  simulationPeriodHours = 0,
  showPeriodHint = true
}: {
  fields: DistributionFields;
  onChange: (patch: Partial<DistributionFields>) => void;
  placeholders?: { min: string; mode: string; max: string };
  step?: number;
  disabled?: boolean;
  simulationPeriodHours?: number;
  showPeriodHint?: boolean;
}) {
  const renderCell = (
    key: keyof DistributionFields,
    placeholder: string,
    title?: string
  ) => {
    const value = fields[key];
    const onValueChange = (next: string) => onChange({ [key]: next });
    if (showPeriodHint) {
      return (
        <HourInputWithPeriodHint
          value={value}
          onChange={onValueChange}
          simulationPeriodHours={simulationPeriodHours}
          min={0}
          step={step}
          placeholder={placeholder}
          title={title}
          disabled={disabled}
        />
      );
    }
    return (
      <TableFieldCell>
        <input
          type="number"
          className="form-input stochastic-leg-num"
          min={0}
          step={step}
          placeholder={placeholder}
          title={title}
          value={value}
          disabled={disabled}
          onChange={(e) => onValueChange(e.target.value)}
        />
      </TableFieldCell>
    );
  };

  return (
    <>
      <td>{renderCell("min", placeholders.min)}</td>
      <td>{renderCell("mode", placeholders.mode, "Peak of triangular distribution; leave empty for uniform")}</td>
      <td>{renderCell("max", placeholders.max)}</td>
    </>
  );
}

export default function StochasticConfigForm({
  value,
  onChange,
  customers,
  simulationPeriodHours = 0,
  headerActions
}: StochasticConfigFormProps) {
  const legRows = useMemo(() => schedulableLegRows(customers), [customers]);
  const defaults = defaultStochasticConfig();
  const config =
    value != null &&
    typeof value === "object" &&
    value.pipeline != null &&
    Array.isArray(value.legDelays) &&
    value.immobilisation != null
      ? value
      : defaults;
  const flowFields = flowMultiplierFieldsFromSpec(config.pipeline.flowMultiplier);
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
    const cfg = delayForLeg(config.legDelays, customerId, direction, legKey);
    return legDelayFieldsFromConfig(cfg);
  };

  const setFlowMultiplierFields = (patch: Partial<DistributionFields>) => {
    const next = { ...flowFields, ...patch };
    onChange({
      ...config,
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

    const rest = config.legDelays.filter(
      (l) =>
        !(
          l.customerId === customerId &&
          l.direction === direction &&
          (l.legKey ?? null) === legKey
        )
    );
    const cfg = legDelayConfigFromFields(fields, { customerId, direction, legKey });
    if (cfg) rest.push(cfg);
    onChange({ ...config, legDelays: rest });
  };

  const upsertDisruptionEvent = (index: number, fields: DisruptionEventFields) => {
    const cfg = disruptionEventFromFields(fields);
    const events = [...config.immobilisation.events];
    if (cfg) {
      events[index] = cfg;
    } else {
      events.splice(index, 1);
    }
    onChange({ ...config, immobilisation: { events } });
  };

  const addDisruptionEvent = (kind: StochasticDisruptionEvent["kind"]) => {
    const events: StochasticDisruptionEvent[] = [
      ...config.immobilisation.events,
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
    onChange({ ...config, immobilisation: { events } });
  };

  const removeDisruptionEvent = (index: number) => {
    const events = config.immobilisation.events.filter((_, i) => i !== index);
    onChange({ ...config, immobilisation: { events } });
  };

  return (
    <div className="card config-section stochastic-config-form">
      <div className="config-section-header stochastic-config-form-header">
        <div>
          <div className="config-section-title-row">
            <div className="config-section-title">Scenario parameters</div>
            <HelpPopover
              label="Stochastics help"
              content="Sample arrival delays, pipeline flow variation, and disruption events on replay. The baseline schedule is preserved; use Sample once on the Gantt to preview one scenario."
            />
          </div>
        </div>
        {headerActions ? <div className="stochastic-config-form-actions">{headerActions}</div> : null}
      </div>

      <label className="form-check">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
        />
        <span>Enable stochastic scenarios</span>
      </label>

      {config.enabled && (
        <>
          {simulationPeriodHours > 0 && (
            <p className="form-hint" style={{ marginTop: 0, marginBottom: 16 }}>
              Simulation period: {simulationPeriodHours.toLocaleString()} h — hour fields show their
              share of this horizon below each value.
            </p>
          )}
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
                value={config.seed ?? ""}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  onChange({
                    ...config,
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
                    Each matching slot first rolls against <strong>P(adjust)</strong> (0–100%). If
                    that succeeds, a shift is drawn from min / most likely / max (hours). Negative
                    values move the slot earlier; positive values delay it (% of simulation period
                    shown below each value).
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
                      <th>P(adjust) %</th>
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
                            <ProbabilityInput
                              value={fields.probability}
                              placeholder="25"
                              title="Probability this leg's timing is adjusted (percent)"
                              onChange={(probability) => updateFields({ probability })}
                            />
                          </td>
                          <td>
                            <HourInputWithPeriodHint
                              value={fields.min}
                              onChange={(min) => updateFields({ min })}
                              simulationPeriodHours={simulationPeriodHours}
                              placeholder="0"
                              title="Minimum shift (h); negative = early arrival"
                            />
                          </td>
                          <td>
                            <HourInputWithPeriodHint
                              value={fields.mode}
                              onChange={(mode) => updateFields({ mode })}
                              simulationPeriodHours={simulationPeriodHours}
                              placeholder="—"
                              title="Peak of triangular distribution; negative = early arrival"
                            />
                          </td>
                          <td>
                            <HourInputWithPeriodHint
                              value={fields.max}
                              onChange={(max) => updateFields({ max })}
                              simulationPeriodHours={simulationPeriodHours}
                              placeholder="Off"
                              title="Maximum shift (h); negative max with negative min = early only"
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
                    Each event rolls once per simulation period against <strong>P(occurs)</strong> (0–100%).
                    If it happens, duration is sampled from min / most likely / max (hours) and start time
                    falls between the start-from / start-to hours (% of period shown below hour fields).{" "}
                    <strong>Terminal</strong> blocks berths; <strong>Pipeline</strong> applies impact (full
                    stop or partial multiplier) for the event window on top of hourly flow variation.
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
            {config.immobilisation.events.length === 0 ? (
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
                      <MultilineTh lines={["P(occurs)", "%"]} />
                      <MultilineTh lines={["Min", "duration (h)"]} />
                      <MultilineTh lines={["Most likely", "duration (h)"]} />
                      <MultilineTh lines={["Max", "duration (h)"]} />
                      <MultilineTh lines={["Start from", "(h)"]} />
                      <MultilineTh lines={["Start to", "(h)"]} />
                      <th>Impact</th>
                      <MultilineTh lines={["Impact", "min"]} />
                      <MultilineTh lines={["Impact", "mode"]} />
                      <MultilineTh lines={["Impact", "max"]} />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {config.immobilisation.events.map((ev, i) => {
                      const fields = disruptionEventFieldsFromConfig(ev);
                      const update = (patch: Partial<DisruptionEventFields>) => {
                        upsertDisruptionEvent(i, { ...fields, ...patch });
                      };
                      const impactDisabled =
                        fields.kind === "terminal" || fields.impactKind === "full_stop";
                      return (
                        <tr key={i}>
                          <td>
                            <TableFieldCell>
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
                            </TableFieldCell>
                          </td>
                          <td>
                            <TableFieldCell>
                              <input
                                type="text"
                                className="form-input"
                                placeholder="Label"
                                value={fields.label}
                                onChange={(e) => update({ label: e.target.value })}
                              />
                            </TableFieldCell>
                          </td>
                          <td>
                            <ProbabilityInput
                              value={fields.probability}
                              placeholder="10"
                              title="Probability event occurs once per simulation period (percent)"
                              onChange={(probability) => update({ probability })}
                            />
                          </td>
                          <DistributionCells
                            fields={fields.duration}
                            onChange={(patch) =>
                              update({ duration: { ...fields.duration, ...patch } })
                            }
                            placeholders={{ min: "0", mode: "8", max: "24" }}
                            simulationPeriodHours={simulationPeriodHours}
                          />
                          <td>
                            <HourInputWithPeriodHint
                              value={fields.startHourMin}
                              onChange={(startHourMin) => update({ startHourMin })}
                              simulationPeriodHours={simulationPeriodHours}
                              min={0}
                              title="Earliest start hour from simulation start"
                            />
                          </td>
                          <td>
                            <HourInputWithPeriodHint
                              value={fields.startHourMax}
                              onChange={(startHourMax) => update({ startHourMax })}
                              simulationPeriodHours={simulationPeriodHours}
                              min={1}
                              title="Latest start hour from simulation start"
                            />
                          </td>
                          <td>
                            <TableFieldCell>
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
                            </TableFieldCell>
                          </td>
                          <DistributionCells
                            fields={fields.impact}
                            onChange={(patch) => update({ impact: { ...fields.impact, ...patch } })}
                            placeholders={{ min: "0.5", mode: "0.75", max: "0.9" }}
                            step={0.05}
                            disabled={impactDisabled}
                            showPeriodHint={false}
                          />
                          <td className="stochastic-disruption-actions">
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
