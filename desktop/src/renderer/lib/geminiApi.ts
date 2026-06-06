const GEMINI_API_KEY_STORAGE = "terminal-scheduler-gemini-api-key";
const GEMINI_MODEL = "gemini-2.0-flash";

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

Structure your response with these sections (use markdown headings):
1. **Executive summary** — 2–4 sentences on overall feasibility and balance
2. **Customer highlights** — which customers look tight, overstocked, or under-served; mention days-of-cover where relevant
3. **Constraints & bottlenecks** — interpret constraint block counts (pace ahead, optimizer, resource occupied, inventory limits, etc.)
4. **Berth utilization** — comment on resource load if data is present
5. **Suggested actions** — 3–5 practical configuration or operational suggestions (optimizer multiplier, pacing, throughput, inventory)

Be specific with numbers from the data. Do not invent data not in the summary. If the simulation looks healthy, say so briefly. Keep the total response under 600 words unless serious issues require more detail.`;

export async function requestGeminiAnalysis(summaryJson: string): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("No Gemini API key saved. Enter your key below and try again.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Analyse this terminal scheduler simulation summary:\n\n${summaryJson}`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2048
      }
    })
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as { error?: { message?: string } };
      if (errBody.error?.message) detail = errBody.error.message;
    } catch {
      /* ignore */
    }
    if (response.status === 400 && detail.includes("API key")) {
      throw new Error("Invalid Gemini API key. Check your key at aistudio.google.com/apikey");
    }
    if (response.status === 429) {
      throw new Error("Gemini rate limit reached. Wait a minute and try again (free tier: ~15 req/min).");
    }
    throw new Error(`Gemini request failed: ${detail}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) {
    throw new Error("Gemini returned an empty response. Try again.");
  }
  return text.trim();
}
