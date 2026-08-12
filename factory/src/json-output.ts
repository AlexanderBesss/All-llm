export function extractJson<T = unknown>(text: string): T {
  const raw = String(text || "").trim();
  const candidates = [raw, raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as T; } catch {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)) as T; } catch {}
  }
  throw new Error("Agent did not return valid JSON.");
}

