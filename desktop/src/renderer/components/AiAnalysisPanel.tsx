import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import {
  buildAnalyticsAiSummary,
  summaryToPromptText,
  type AnalyticsAiSummary
} from "../lib/buildAnalyticsAiSummary";
import {
  getGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
  requestGeminiAnalysis
} from "../lib/geminiApi";
import type { SimulationLogRow } from "../../engine/simulationLog";

interface AiAnalysisPanelProps {
  config: {
    startDate?: string;
    endDate?: string;
    storageMode?: string;
    totalStorageCapacity?: number;
    optimizerRelativeDocMultiplier?: number;
    pacerRoundingDirection?: string;
    pacerRoundAtDecile?: number;
  } | null;
  periodHours: number;
  customers: Array<{ name: string; pipelineFlowPerHour?: number; storageShare?: number }>;
  feasibilityWarnings: string[];
  simulationLog: SimulationLogRow[];
  inventorySummary: Array<{
    customerName: string;
    starting: number;
    final: number;
    min: number;
    max: number;
    daysOfCover: number | null;
    massInbound: number;
    massOutbound: number;
    inventoryDelta: number;
  }>;
  throughputCoverage: Array<{
    customerName: string;
    expectedOutbound: number;
    scheduledOutbound: number;
    passes: boolean;
    targetInboundSlots: number;
    targetOutboundSlots: number;
    scheduledInboundSlots: number;
    scheduledOutboundSlots: number;
  }>;
  tankExtremes: Array<{ customerName: string; bottomHours: number; topHours: number }>;
  partialLoads: Array<{
    customerName: string;
    partialInboundSlots: number;
    partialOutboundSlots: number;
  }>;
  resourceUtilization: Array<{
    resourceName: string;
    resourceType: string;
    totalSlots: number;
    utilizationPct: number;
    totalHoursOccupied: number;
  }>;
  totalSlots: number;
  hasRunData: boolean;
}

function renderMarkdownish(text: string): ReactNode[] {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`} className="ai-analysis-list">
        {listItems.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s+/, ""));
      continue;
    }
    flushList();
    if (/^#{1,3}\s+/.test(trimmed) || /^\*\*.+\*\*$/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,3}\s+/, "").replace(/\*\*/g, "");
      nodes.push(
        <h4 key={`h-${i}`} className="ai-analysis-heading">
          {heading}
        </h4>
      );
    } else {
      nodes.push(
        <p key={`p-${i}`} className="ai-analysis-paragraph">
          {trimmed.replace(/\*\*(.+?)\*\*/g, "$1")}
        </p>
      );
    }
  }
  flushList();
  return nodes;
}

export default function AiAnalysisPanel(props: AiAnalysisPanelProps) {
  const [apiKeyInput, setApiKeyInput] = useState(() => getGeminiApiKey());
  const [showKeyField, setShowKeyField] = useState(() => !getGeminiApiKey());
  const [userNotes, setUserNotes] = useState("");
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);

  const summary: AnalyticsAiSummary | null = useMemo(
    () =>
      buildAnalyticsAiSummary({
        config: props.config,
        periodHours: props.periodHours,
        customers: props.customers,
        feasibilityWarnings: props.feasibilityWarnings,
        simulationLog: props.simulationLog,
        inventorySummary: props.inventorySummary,
        throughputCoverage: props.throughputCoverage,
        tankExtremes: props.tankExtremes,
        partialLoads: props.partialLoads,
        resourceUtilization: props.resourceUtilization,
        totalSlots: props.totalSlots
      }),
    [props]
  );

  const handleSaveKey = () => {
    if (!apiKeyInput.trim()) {
      setError("Paste a Gemini API key first.");
      return;
    }
    setGeminiApiKey(apiKeyInput);
    setShowKeyField(false);
    setError(null);
  };

  const handleClearKey = () => {
    clearGeminiApiKey();
    setApiKeyInput("");
    setShowKeyField(true);
  };

  const handleAnalyse = async () => {
    setError(null);
    if (!summary) {
      setError("Run the scheduler first — there is no simulation data to analyse.");
      return;
    }
    if (!getGeminiApiKey()) {
      setShowKeyField(true);
      setError("Save your Gemini API key before requesting analysis.");
      return;
    }

    setLoading(true);
    setAnalysis(null);
    try {
      const promptText = summaryToPromptText(summary, userNotes);
      const result = await requestGeminiAnalysis(promptText);
      setAnalysis(result);
      setLastSentAt(new Date().toLocaleString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card ai-analysis-panel">
      <div className="ai-analysis-header">
        <div>
          <div className="card-title" style={{ marginBottom: 4 }}>
            AI analysis
          </div>
          <p className="ai-analysis-intro">
            Click <strong>Get AI analysis</strong> to send a compact summary of this run to Google Gemini.
            Nothing is sent until you click. Your API key stays in this browser only (
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
              get a free key
            </a>
            ).
          </p>
        </div>
      </div>

      {showKeyField ? (
        <div className="ai-analysis-key-block">
          <label className="form-label" htmlFor="gemini-api-key">
            Gemini API key
          </label>
          <div className="ai-analysis-key-row">
            <input
              id="gemini-api-key"
              type="password"
              className="form-input"
              placeholder="AIza…"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              autoComplete="off"
            />
            <button type="button" className="btn btn-secondary" onClick={handleSaveKey}>
              Save key
            </button>
          </div>
        </div>
      ) : (
        <div className="ai-analysis-key-saved">
          <span className="badge badge-blue">API key saved</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowKeyField(true)}>
            Change key
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleClearKey}>
            Remove key
          </button>
        </div>
      )}

      <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
        <label className="form-label" htmlFor="ai-user-notes">
          Optional context (not sent unless you click analyse)
        </label>
        <textarea
          id="ai-user-notes"
          className="form-input ai-analysis-notes"
          rows={2}
          placeholder="e.g. Customer A has priority; testing optimizer at 1.2× average DoC…"
          value={userNotes}
          onChange={(e) => setUserNotes(e.target.value)}
        />
      </div>

      <div className="ai-analysis-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleAnalyse}
          disabled={loading || !props.hasRunData}
        >
          {loading ? "Analysing…" : "Get AI analysis"}
        </button>
        {!props.hasRunData && (
          <span className="form-helper" style={{ margin: 0 }}>
            Run the scheduler on the Dashboard first.
          </span>
        )}
      </div>

      {error && <div className="alert alert-error ai-analysis-alert">{error}</div>}

      {loading && (
        <div className="ai-analysis-loading">
          <div className="ai-analysis-spinner" aria-hidden />
          Sending summary to Gemini…
        </div>
      )}

      {analysis && !loading && (
        <div className="ai-analysis-result">
          {lastSentAt && (
            <div className="ai-analysis-meta">Generated {lastSentAt}</div>
          )}
          <div className="ai-analysis-body">{renderMarkdownish(analysis)}</div>
        </div>
      )}
    </div>
  );
}
