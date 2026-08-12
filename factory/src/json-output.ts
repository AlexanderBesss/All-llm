function parseCandidate<T>(candidate: string): T | undefined {
  try { return JSON.parse(candidate) as T; } catch { return undefined; }
}

function findEmbeddedJson<T>(raw: string): T | undefined {
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{" && raw[start] !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character === "{" ? "}" : "]");
        continue;
      }
      if (character === "}" || character === "]") {
        if (stack.pop() !== character) break;
        if (stack.length === 0) {
          const parsed = parseCandidate<T>(raw.slice(start, index + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return undefined;
}

export function extractJson<T = unknown>(text: string): T {
  const raw = String(text || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = parseCandidate<T>(raw) || parseCandidate<T>(unfenced) || findEmbeddedJson<T>(unfenced);
  if (parsed !== undefined) return parsed;
  throw new Error("Agent did not return valid JSON.");
}

