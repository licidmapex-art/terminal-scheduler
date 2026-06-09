import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import {
  buildAnalyticsAiSummary,
  summaryToPromptText,
  questionToPromptText,
  type AnalyticsAiSummary
} from "../lib/buildAnalyticsAiSummary";
import {
  getGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
  requestGeminiAnalysis,
  testGeminiApiConnection,
  type AiAnalysisRequestMode
} from "../lib/geminiApi";
import type { SimulationLogRow } from "../../engine/simulationLog";
import { HelpPopover } from "./HelpPopover";

interface AiAnalysisPanelProps {
  config: {
    startDate?: string;
    endDate?: string;
    storageMode?: string;
    totalStorageCapacity?: number;
    optimizerRelativeDocMultiplier?: number;
    pacerInboundRoundAtDecile?: number;
    pacerInboundAllowance?: number;
    pacerOutboundRoundAtDecile?: number;
    pacerOutboundAllowance?: number;
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
    expectedInbound: number;
    scheduledInbound: number;
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
  const [requestMode, setRequestMode] = useState<AiAnalysisRequestMode>("summary");
  const [customQuestion, setCustomQuestion] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState<string | null>(null);
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

  const handleTestConnection = async () => {
    setError(null);
    setTestSuccess(null);
    if (!getGeminiApiKey()) {
      setShowKeyField(true);
      setError("Save your Gemini API key first, then test the connection.");
      return;
    }

    setLoading(true);
    setLoadingStatus("Testing Gemini connection…");
    try {
      const result = await testGeminiApiConnection(setLoadingStatus);
      setTestSuccess(`Connected via ${result.model}. Reply: "${result.reply.slice(0, 40)}"`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingStatus(null);
    }
  };

  const handleAnalyse = async (forceRefresh = false) => {
    setError(null);
    setTestSuccess(null);
    setFromCache(false);
    if (!summary) {
      setError("Run the scheduler first — there is no simulation data to analyse.");
      return;
    }
    if (!getGeminiApiKey()) {
      setShowKeyField(true);
      setError("Save your Gemini API key before requesting analysis.");
      return;
    }

    const question = customQuestion.trim();
    if (requestMode === "question" && !question) {
      setError("Enter a question to send to Gemini.");
      return;
    }

    setLoading(true);
    setLoadingStatus(
      forceRefresh
        ? requestMode === "question"
          ? "Requesting fresh answer…"
          : "Requesting fresh analysis…"
        : requestMode === "question"
          ? "Sending question to Gemini…"
          : "Sending summary to Gemini…"
    );
    try {
      const promptText =
        requestMode === "question"
          ? questionToPromptText(summary, question, userNotes)
          : summaryToPromptText(summary, userNotes);
      let usedCache = false;
      const result = await requestGeminiAnalysis(promptText, {
        forceRefresh,
        mode: requestMode,
        question: requestMode === "question" ? question : undefined,
        onStatus: (msg) => {
          if (msg.startsWith("Using cached")) usedCache = true;
          setLoadingStatus(msg);
        }
      });
      setAnalysis(result);
      setFromCache(usedCache);
      setLastSentAt(new Date().toLocaleString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingStatus(null);
    }
  };

  return (
    <div className="card ai-analysis-panel">
      <div className="ai-analysis-header">
        <div>
          <div className="card-title-row" style={{ marginBottom: 4 }}>
            <div className="card-title" style={{ margin: 0 }}>
              AI analysis
            </div>
            <HelpPopover
              label="AI analysis help"
              content={
                <>
                  Click <strong>Get AI summary</strong> for a structured overview, or choose <strong>Ask a question</strong> for a bespoke answer about the same run data.
                  Nothing is sent until you click. If you see rate-limit errors on a new key, open AI Studio → API Keys
                  → <strong>Set up billing</strong> on that project (free tier still applies). Use{" "}
                  <strong>Test connection</strong> after saving a key. Your key stays in this browser only (
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
                    get a free key
                  </a>
                  ).
                </>
              }
            />
          </div>
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
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestConnection}
              disabled={loading || !apiKeyInput.trim()}
            >
              Test connection
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleTestConnection}
            disabled={loading}
          >
            Test connection
          </button>
        </div>
      )}

      <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
        <span className="form-label">Request type</span>
        <div className="form-radio-group" style={{ marginTop: 6 }}>
          <label className="form-radio-option">
            <input
              type="radio"
              name="ai-request-mode"
              value="summary"
              checked={requestMode === "summary"}
              onChange={() => setRequestMode("summary")}
            />
            <span>
              <span className="form-radio-option-title">Summary</span>
            </span>
          </label>
          <label className="form-radio-option">
            <input
              type="radio"
              name="ai-request-mode"
              value="question"
              checked={requestMode === "question"}
              onChange={() => setRequestMode("question")}
            />
            <span>
              <span className="form-radio-option-title">Ask a question</span>
            </span>
          </label>
        </div>
      </div>

      {requestMode === "question" && (
        <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
          <label className="form-label" htmlFor="ai-custom-question">
            Your question
          </label>
          <textarea
            id="ai-custom-question"
            className="form-input ai-analysis-notes"
            rows={3}
            placeholder="e.g. Why does Ineos get more inbound ships than AL despite similar throughput targets?"
            value={customQuestion}
            onChange={(e) => setCustomQuestion(e.target.value)}
          />
        </div>
      )}

      <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
        <label className="form-label" htmlFor="ai-user-notes">
          {requestMode === "summary" ? "Optional context" : "Optional extra context"}
        </label>
        <textarea
          id="ai-user-notes"
          className="form-input ai-analysis-notes"
          rows={2}
          placeholder={
            requestMode === "summary"
              ? "e.g. Customer A has priority; testing optimizer at 1.2× average DoC…"
              : "e.g. Focus on shared-inventory mode and berth pacing…"
          }
          value={userNotes}
          onChange={(e) => setUserNotes(e.target.value)}
        />
        <span className="form-helper">Included in the JSON sent to Gemini when you click analyse.</span>
      </div>

      <div className="ai-analysis-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => handleAnalyse(false)}
          disabled={loading || !props.hasRunData}
        >
          {loading
            ? requestMode === "question"
              ? "Asking…"
              : "Analysing…"
            : requestMode === "question"
              ? "Ask Gemini"
              : "Get AI summary"}
        </button>
        {analysis && !loading && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => handleAnalyse(true)}
            disabled={loading || !props.hasRunData}
            title="Bypass cache and call Gemini again"
          >
            {requestMode === "question" ? "Refresh answer" : "Refresh summary"}
          </button>
        )}
        {!props.hasRunData && (
          <span className="form-helper" style={{ margin: 0 }}>
            Run the scheduler on the Schedule page first.
          </span>
        )}
      </div>

      {error && (
        <div className="alert alert-error ai-analysis-alert" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}

      {testSuccess && !error && (
        <div className="alert alert-success ai-analysis-alert">{testSuccess}</div>
      )}

      {loading && (
        <div className="ai-analysis-loading">
          <div className="ai-analysis-spinner" aria-hidden />
          {loadingStatus ??
            (requestMode === "question" ? "Sending question to Gemini…" : "Sending summary to Gemini…")}
        </div>
      )}

      {analysis && !loading && (
        <div className="ai-analysis-result">
          {lastSentAt && (
            <div className="ai-analysis-meta">
              Generated {lastSentAt}
              {fromCache ? " · from session cache (no API call)" : ""}
            </div>
          )}
          <div className="ai-analysis-body">{renderMarkdownish(analysis)}</div>
        </div>
      )}
    </div>
  );
}
