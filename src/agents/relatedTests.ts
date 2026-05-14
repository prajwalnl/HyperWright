import fs from "node:fs/promises";
import path from "node:path";

/**
 * Build an index of `test("title", …)` declarations across an existing tests
 * directory and use it to flag generated specs that look like duplicates.
 *
 * The match is intentionally conservative: titles share at least two
 * significant tokens (>= 4 chars, not in STOPWORDS). False positives waste a
 * line of human review; false negatives just miss a hint. We tune toward the
 * former.
 */

export interface ExistingTest {
  /** Relative file path (relative to existingTestsDir). */
  file: string;
  /** Full test() title. */
  title: string;
  /** Pre-tokenised significant words for cheap matching. */
  tokens: Set<string>;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "then",
  "test",
  "tests",
  "should",
  "shall",
  "will",
  "have",
  "been",
  "were",
  "page",
  "user",
  "users",
  "click",
  "clicks",
  "displays",
  "display",
  "show",
  "shows",
]);

const TEST_RE = /(?<![A-Za-z0-9_])test(?:\.[a-zA-Z]+)?\s*\(\s*(['"`])([^'"`]+?)\1/g;

function tokenize(title: string): Set<string> {
  const out = new Set<string>();
  for (const word of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 4) continue;
    if (STOPWORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

async function walkSpecs(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        stack.push(full);
      } else if (e.isFile() && /\.spec\.[tj]sx?$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

export async function buildExistingTestIndex(
  existingTestsDir: string,
): Promise<ExistingTest[]> {
  const specs = await walkSpecs(existingTestsDir);
  const idx: ExistingTest[] = [];
  for (const file of specs) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(TEST_RE)) {
      const title = m[2];
      idx.push({
        file: path.relative(existingTestsDir, file),
        title,
        tokens: tokenize(title),
      });
    }
  }
  return idx;
}

export function findRelated(
  generatedTitle: string,
  index: ExistingTest[],
): ExistingTest[] {
  const target = tokenize(generatedTitle);
  if (target.size === 0) return [];
  const hits: Array<{ entry: ExistingTest; overlap: number }> = [];
  for (const entry of index) {
    let overlap = 0;
    for (const t of target) if (entry.tokens.has(t)) overlap++;
    if (overlap >= 2) hits.push({ entry, overlap });
  }
  hits.sort((a, b) => b.overlap - a.overlap);
  return hits.slice(0, 3).map((h) => h.entry);
}

/**
 * Rewrite a generated spec in place: prepend a `// REVIEW: …` comment above
 * each `test(...)` that overlaps with one or more existing tests. Idempotent —
 * if the comment is already there, leave it alone.
 */
export async function annotateGeneratedSpec(
  specPath: string,
  index: ExistingTest[],
  existingTestsDir: string,
): Promise<number> {
  if (index.length === 0) return 0;
  const content = await fs.readFile(specPath, "utf8");
  const lines = content.split("\n");
  const out: string[] = [];
  let annotations = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)(?:test(?:\.[a-zA-Z]+)?)\s*\(\s*(['"`])([^'"`]+?)\2/.exec(
      line,
    );
    if (m) {
      const indent = m[1];
      const title = m[3];
      const prev = out[out.length - 1] ?? "";
      const alreadyAnnotated = prev.trimStart().startsWith("// REVIEW:");
      if (!alreadyAnnotated) {
        const related = findRelated(title, index);
        if (related.length > 0) {
          const refs = related
            .map((r) => `"${r.title}" (${path.join(existingTestsDir, r.file)})`)
            .join("; ");
          out.push(
            `${indent}// REVIEW: similar existing test${related.length > 1 ? "s" : ""} — consider updating instead of duplicating: ${refs}`,
          );
          annotations++;
        }
      }
    }
    out.push(line);
  }

  if (annotations > 0) {
    await fs.writeFile(specPath, out.join("\n"), "utf8");
  }
  return annotations;
}
