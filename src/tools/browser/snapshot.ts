import type { Page } from "playwright";

/** Condensed DOM snapshot of interactive elements, sized for LLM context. */
export async function captureSnapshot(page: Page): Promise<string> {
  const title = await page.title();
  const url = page.url();
  const items = await page.evaluate(() => {
    const take = (el: Element) => {
      const attr = (n: string) => el.getAttribute(n);
      const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
      const text = (el as HTMLElement).innerText
        ?.slice(0, 80)
        .replace(/\s+/g, " ")
        .trim();
      const selectors = [
        attr("data-testid") && `[data-testid="${attr("data-testid")}"]`,
        attr("name") && `[name="${attr("name")}"]`,
        attr("placeholder") && `[placeholder="${attr("placeholder")}"]`,
        (el as HTMLElement).id && `#${(el as HTMLElement).id}`,
      ].filter(Boolean) as string[];
      return {
        role,
        text,
        selectors,
        type: attr("type") ?? undefined,
        aria: attr("aria-label") ?? undefined,
      };
    };
    const q =
      "button, a, input, select, textarea, [role='button'], [role='link'], [data-testid], h1, h2, h3, label";
    return Array.from(document.querySelectorAll(q)).slice(0, 150).map(take);
  });

  const lines = [`URL: ${url}`, `Title: ${title}`, "", "Interactive elements:"];
  for (const it of items) {
    const parts = [`- ${it.role}`];
    if (it.type) parts.push(`type=${it.type}`);
    if (it.aria) parts.push(`aria="${it.aria}"`);
    if (it.text) parts.push(`text="${it.text}"`);
    if (it.selectors.length) parts.push(`sel=${it.selectors.join(" | ")}`);
    lines.push(parts.join(" "));
  }
  const out = lines.join("\n");
  return out.length > 8000 ? out.slice(0, 8000) + "\n…(truncated)" : out;
}

/**
 * Infer Playwright's recommended locator for an element already on the page.
 * Priority matches SKILL.md §Selector Strategy:
 *   getByRole → getByLabel → getByPlaceholder → getByText → getByTestId → data-* → CSS
 */
export async function generateLocator(page: Page, selector: string): Promise<string> {
  const info = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const a = (n: string) => el.getAttribute(n);
    return {
      role: a("role") ?? el.tagName.toLowerCase(),
      name: a("aria-label"),
      label: (() => {
        if (!(el as HTMLElement).id) return null;
        const l = document.querySelector(`label[for="${(el as HTMLElement).id}"]`);
        return l ? (l as HTMLElement).innerText.trim() : null;
      })(),
      placeholder: a("placeholder"),
      text: (el as HTMLElement).innerText?.slice(0, 60).trim(),
      testId: a("data-testid"),
      id: (el as HTMLElement).id,
      name_attr: a("name"),
      tag: el.tagName.toLowerCase(),
    };
  }, selector);

  if (!info) return `(no element matched "${selector}")`;

  if (info.testId) return `page.getByTestId(${JSON.stringify(info.testId)})`;
  const interactiveRoles = ["button", "link", "textbox", "checkbox", "combobox", "radio", "tab"];
  if (interactiveRoles.includes(info.role) && info.name) {
    return `page.getByRole(${JSON.stringify(info.role)}, { name: ${JSON.stringify(info.name)} })`;
  }
  if (info.label) return `page.getByLabel(${JSON.stringify(info.label)})`;
  if (info.placeholder) return `page.getByPlaceholder(${JSON.stringify(info.placeholder)})`;
  if (info.text && info.text.length >= 3) {
    return `page.getByText(${JSON.stringify(info.text)}, { exact: false })`;
  }
  if (info.id) return `page.locator("#${info.id}")`;
  if (info.name_attr) return `page.locator(${JSON.stringify(`[name="${info.name_attr}"]`)})`;
  return `page.locator(${JSON.stringify(selector)})`;
}
