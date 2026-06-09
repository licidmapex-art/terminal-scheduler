const GEMINI_API_KEY_STORAGE = "terminal-scheduler-gemini-api-key";
const GEMINI_CACHE_STORAGE = "terminal-scheduler-gemini-analysis-cache";
/** Prefer current models — gemini-2.0-flash free tier is often 0 / deprecated. */
const GEMINI_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest"
] as const;
const MAX_RATE_LIMIT_RETRIES = 2;
const MIN_REQUEST_INTERVAL_MS = 4_000;

let lastRequestAt = 0;

export function getGeminiApiKey(): string {
  try {
    return localStorage.getItem(GEMINI_API_KEY_STORAGE)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setGeminiApiKey(key: string): void {
  localStorage.setItem(GEMINI_API_KEY_STORAGE, key.trim());
}

export function clearGeminiApiKey(): void {
  localStorage.removeItem(GEMINI_API_KEY_STORAGE);
}

const SYSTEM_INSTRUCTION = `You are an expert analyst for a terminal scheduling and inventory simulation tool for bulk liquid/gas terminals.

The user will provide a JSON summary of one simulation run. Analyse it clearly and concisely for a terminal planner.

Structure your response with these markdown headings:
1. **Executive summary** — 2–4 sentences on overall feasibility and balance
2. **Customer highlights** — which customers look tight, overstocked, or under-served; mention days-of-cover where relevant
3. **Constraints & bottlenecks** — interpret constraint block counts (pace ahead, optimizer, resource occupied, inventory limits, etc.)
4. **Berth utilization** — comment on resource load if data is present
5. **Suggested actions** — 3–5 practical configuration or operational suggestions (optimizer multiplier, pacing, throughput, inventory)

Be specific with numbers from the data. Do not invent data not in the summary. If the simulation looks healthy, say so briefly. Keep the total response under 600 words unless serious issues require more detail.`;

const SYSTEM_INSTRUCTION_QUESTION = `You are an expert analyst for a terminal scheduling and inventory simulation tool for bulk liquid/gas terminals.

The user will provide a JSON summary of one simulation run and a specific question about that run. Answer the question clearly and concisely for a terminal planner.

Use only data from the summary. Be specific with numbers where relevant. If the summary does not contain enough information to answer fully, say what is missing and what you can infer. Do not invent figures not present in the summary. Use short paragraphs or bullet lists as appropriate; no fixed section template unless the question asks for one.`;

export type AiAnalysisRequestMode = "summary" | "question";

export interface GeminiAnalysisOptions {
  /** Skip session cache and force a new API call. */
  forceRefresh?: boolean;
  /** Called while waiting on rate-limit retries or model fallbacks. */
  onStatus?: (message: string) => void;
  /** Structured summary vs answering a user question. */
  mode?: AiAnalysisRequestMode;
  /** Required when mode is "question". */
  question?: string;
}

interface CachedAnalysis {
  promptHash: string;
  analysis: string;
  cachedAt: string;
}

interface GeminiErrorBody {
  error?: {
    message?: string;
    status?: string;
    code?: number;
    details?: unknown[];
  };
}

type GeminiCallResult =
  | { ok: true; text: string }
  | { ok: false; status: number; detail: string; retryAfterMs: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function hashPrompt(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function readAnalysisCache(): CachedAnalysis | null {
  try {
    const raw = sessionStorage.getItem(GEMINI_CACHE_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAnalysis;
    if (
      typeof parsed.promptHash === "string" &&
      typeof parsed.analysis === "string" &&
      parsed.analysis.trim()
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeAnalysisCache(promptHash: string, analysis: string): void {
  try {
    const payload: CachedAnalysis = {
      promptHash,
      analysis,
      cachedAt: new Date().toISOString()
    };
    sessionStorage.setItem(GEMINI_CACHE_STORAGE, JSON.stringify(payload));
  } catch {
    /* ignore quota errors */
  }
}

function parseRetryDelayMs(response: Response, attempt: number): number {
  const retryAfterHeader = response.headers.get("Retry-After");
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return Math.min(60_000, 8_000 * 2 ** attempt);
}

async function parseGeminiError(response: Response): Promise<{ detail: string; body: GeminiErrorBody | null }> {
  let body: GeminiErrorBody | null = null;
  let detail = `HTTP ${response.status}`;
  try {
    body = (await response.json()) as GeminiErrorBody;
    if (body.error?.message) detail = body.error.message;
  } catch {
    /* ignore */
  }
  return { detail, body };
}

function isZeroQuotaError(detail: string): boolean {
  const lower = detail.toLowerCase();
  return (
    detail.includes("limit: 0") ||
    (lower.includes("free_tier") && lower.includes("limit: 0")) ||
    (lower.includes("quota") && lower.includes("billing details"))
  );
}

function isModelUnavailable(status: number, detail: string): boolean {
  const lower = detail.toLowerCase();
  return (
    status === 404 ||
    lower.includes("not found") ||
    lower.includes("not supported") ||
    lower.includes("shut down") ||
    lower.includes("deprecated")
  );
}

function formatGeminiFailure(status: number, detail: string, model: string): string {
  const lower = detail.toLowerCase();

  if (status === 400 && lower.includes("api key")) {
    return "Invalid Gemini API key. Create or copy a key at aistudio.google.com/apikey, save it here, then use Test connection.";
  }

  if (isZeroQuotaError(detail)) {
    return (
      `Gemini reports no free-tier quota for model "${model}" on this project (limit: 0). ` +
      "In AI Studio → API Keys, click Set up billing on that key's project — free tier still applies and you are not charged until you exceed free limits. " +
      "Then click Test connection. " +
      `(Google: ${detail})`
    );
  }

  if (status === 429) {
    return (
      `Gemini quota / rate limit (${model}): ${detail}. ` +
      "If this happens on the first try, enable billing on the API key project in AI Studio. Otherwise wait 1–2 minutes."
    );
  }

  if (status === 403) {
    return `Gemini access denied (${model}): ${detail}. Check that the Generative Language API is enabled for your project.`;
  }

  return `Gemini request failed (${model}): ${detail}`;
}

function buildRequestBody(summaryJson: string, mode: AiAnalysisRequestMode, question?: string): string {
  const systemInstruction = mode === "question" ? SYSTEM_INSTRUCTION_QUESTION : SYSTEM_INSTRUCTION;
  const userText =
    mode === "question"
      ? `Simulation summary (JSON):\n\n${summaryJson}\n\nUser question:\n${question?.trim() ?? ""}`
      : `Analyse this terminal scheduler simulation summary:\n\n${summaryJson}`;

  return JSON.stringify({
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userText }]
      }
    ],
    generationConfig: {
      temperature: mode === "question" ? 0.35 : 0.4,
      maxOutputTokens: 2048
    }
  });
}

function buildTestRequestBody(): string {
  return JSON.stringify({
    contents: [{ parts: [{ text: "Reply with exactly: OK" }] }],
    generationConfig: { maxOutputTokens: 16 }
  });
}

async function callGeminiModel(model: string, apiKey: string, body: string): Promise<GeminiCallResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  if (response.ok) {
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) {
      return { ok: false, status: 502, detail: "Empty response from Gemini", retryAfterMs: 0 };
    }
    return { ok: true, text: text.trim() };
  }

  const { detail } = await parseGeminiError(response);
  return {
    ok: false,
    status: response.status,
    detail,
    retryAfterMs: parseRetryDelayMs(response, 0)
  };
}

async function runWithModelFallback(
  apiKey: string,
  body: string,
  onStatus?: (message: string) => void
): Promise<{ text: string; model: string }> {
  let lastError = "Gemini request failed";

  for (const model of GEMINI_MODELS) {
    onStatus?.(`Trying ${model}…`);

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      lastRequestAt = Date.now();
      const result = await callGeminiModel(model, apiKey, body);

      if (result.ok) {
        return { text: result.text, model };
      }

      lastError = formatGeminiFailure(result.status, result.detail, model);

      if (isModelUnavailable(result.status, result.detail) || isZeroQuotaError(result.detail)) {
        onStatus?.(`${model} unavailable — trying next model…`);
        break;
      }

      if (result.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const waitMs = Math.max(result.retryAfterMs, 8_000 * 2 ** attempt);
        onStatus?.(`Rate limited on ${model} — retrying in ${Math.ceil(waitMs / 1000)}s…`);
        await sleep(waitMs);
        continue;
      }

      if (result.status === 429) {
        break;
      }

      throw new Error(lastError);
    }
  }

  throw new Error(lastError);
}

export async function testGeminiApiConnection(
  onStatus?: (message: string) => void
): Promise<{ ok: true; model: string; reply: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("No Gemini API key saved.");
  }

  const { text, model } = await runWithModelFallback(apiKey, buildTestRequestBody(), onStatus);
  return { ok: true, model, reply: text };
}

export async function requestGeminiAnalysis(
  summaryJson: string,
  options: GeminiAnalysisOptions = {}
): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("No Gemini API key saved. Enter your key below and try again.");
  }

  const mode = options.mode ?? "summary";
  const question = options.question?.trim() ?? "";
  if (mode === "question" && !question) {
    throw new Error("Enter a question before requesting analysis.");
  }

  const cacheKey = `${mode}\0${mode === "question" ? question : ""}\0${summaryJson}`;
  const promptHash = hashPrompt(cacheKey);
  if (!options.forceRefresh) {
    const cached = readAnalysisCache();
    if (cached?.promptHash === promptHash) {
      options.onStatus?.("Using cached analysis for this run.");
      return cached.analysis;
    }
  }

  const sinceLastRequest = Date.now() - lastRequestAt;
  if (sinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    const waitMs = MIN_REQUEST_INTERVAL_MS - sinceLastRequest;
    options.onStatus?.(`Waiting ${Math.ceil(waitMs / 1000)}s before sending…`);
    await sleep(waitMs);
  }

  const { text } = await runWithModelFallback(
    apiKey,
    buildRequestBody(summaryJson, mode, question),
    options.onStatus
  );
  writeAnalysisCache(promptHash, text);
  return text;
}
