/**
 * Pull the first balanced, parseable JSON object out of an LLM response.
 *
 * Tried in order, returning the first one that JSON.parse accepts:
 *   1. ```json fenced block (explicit — wins over generic fences)
 *   2. Any other fenced block (some models drop the json tag)
 *   3. Brace-balanced scan of the raw text
 *
 * Each candidate location is scanned for ALL balanced { ... } substrings —
 * not just the first — because LLM prose often contains stray `{` inside
 * regex literals, code samples, or English ("the {key: value} pattern").
 * A naive "first balanced object wins" picks those up and dies with a
 * cryptic JSON.parse error like "Expected property name at position 2".
 *
 * Throws a descriptive error if no candidate parses, so callers can
 * distinguish "agent gave up and wrote prose" from real schema problems.
 */
export function extractJsonObject<T>(raw: string): T {
  const candidates: string[] = [];
  // 1. ```json fences first.
  for (const m of raw.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    candidates.push(m[1]);
  }
  // 2. Untagged fences (only if no json fences matched).
  if (candidates.length === 0) {
    for (const m of raw.matchAll(/```(?:\w+)?\s*([\s\S]*?)```/gi)) {
      candidates.push(m[1]);
    }
  }
  // 3. The raw body, last resort.
  candidates.push(raw);

  let lastErr: unknown = null;
  for (const body of candidates) {
    for (const slice of balancedObjects(body)) {
      try {
        return JSON.parse(slice) as T;
      } catch (e) {
        lastErr = e;
      }
    }
  }

  const reason =
    lastErr instanceof Error
      ? `last parse error: ${lastErr.message}`
      : "no balanced JSON object found";
  throw new Error(
    `Could not extract a JSON object from LLM output (${reason}).\n` +
      `--- raw output (first 500 chars) ---\n${raw.slice(0, 500)}`,
  );
}

/**
 * Yield every balanced `{ ... }` substring in `body` in order of appearance.
 * Tracks string state so braces inside JSON strings don't fool the depth
 * counter. Note: this still yields false candidates for `{` inside JS
 * regex literals or comments, but the caller handles JSON.parse failure
 * by trying the next slice.
 */
function* balancedObjects(body: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        yield body.slice(start, i + 1);
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
}

/** Same as extractJsonObject but for the first fenced code block (any lang). */
export function extractFencedCode(raw: string): string {
  const m = raw.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (!m) return raw.trim();
  return m[1].trim();
}
