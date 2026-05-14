/**
 * Playwright-MCP-compatible browser tool surface for the planner / generator /
 * healer sub-agents. Naming mirrors the `playwright-test*browser_*` tool
 * registry so prompts (and SKILL.md references) carry over 1:1.
 *
 *   Navigation  : browser_navigate, browser_navigate_back
 *   Interaction : browser_click, browser_hover, browser_type, browser_select_option,
 *                 browser_press_key, browser_drag, browser_file_upload,
 *                 browser_wait_for, browser_handle_dialog
 *   Inspection  : browser_snapshot, browser_generate_locator, browser_console_messages,
 *                 browser_network_requests, browser_evaluate, browser_run_code,
 *                 browser_take_screenshot
 *   Verification: browser_verify_element_visible, browser_verify_list_visible,
 *                 browser_verify_text_visible, browser_verify_value
 *   Storage     : browser_cookie_get, browser_storage_state, browser_set_storage_state
 *   Lifecycle   : browser_close
 */
import { tool } from "@langchain/core/tools";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  armDialog,
  closeBrowser,
  consoleLog,
  context,
  ensurePage,
  networkLog,
} from "./browser/singleton.js";
import { captureSnapshot, generateLocator } from "./browser/snapshot.js";

export { closeBrowser };

// --- Navigation -------------------------------------------------------------

const browserNavigate = tool(
  async ({ url }) => {
    const page = await ensurePage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    return `Navigated to ${page.url()}`;
  },
  {
    name: "browser_navigate",
    description: "Navigate the shared browser to a URL. Waits for networkidle.",
    schema: z.object({ url: z.string().url() }),
  },
);

const browserNavigateBack = tool(
  async () => {
    const page = await ensurePage();
    await page.goBack({ waitUntil: "networkidle", timeout: 30_000 });
    return `Back → ${page.url()}`;
  },
  {
    name: "browser_navigate_back",
    description: "Go back to the previous URL in history.",
    schema: z.object({}),
  },
);

// --- Interaction ------------------------------------------------------------

const browserClick = tool(
  async ({ selector }) => {
    const page = await ensurePage();
    await page.locator(selector).click({ timeout: 10_000 });
    return `Clicked ${selector}`;
  },
  {
    name: "browser_click",
    description: "Click an element by Playwright selector.",
    schema: z.object({ selector: z.string() }),
  },
);

const browserHover = tool(
  async ({ selector }) => {
    const page = await ensurePage();
    await page.locator(selector).hover({ timeout: 10_000 });
    return `Hovered ${selector}`;
  },
  {
    name: "browser_hover",
    description: "Hover an element.",
    schema: z.object({ selector: z.string() }),
  },
);

const browserType = tool(
  async ({ selector, value }) => {
    const page = await ensurePage();
    await page.locator(selector).fill(value, { timeout: 10_000 });
    return `Filled ${selector}`;
  },
  {
    name: "browser_type",
    description: "Fill a form input (clears existing value first).",
    schema: z.object({ selector: z.string(), value: z.string() }),
  },
);

const browserSelectOption = tool(
  async ({ selector, value }) => {
    const page = await ensurePage();
    await page
      .locator(selector)
      .selectOption(Array.isArray(value) ? value : [value], { timeout: 10_000 });
    return `Selected ${JSON.stringify(value)} on ${selector}`;
  },
  {
    name: "browser_select_option",
    description: "Select one or more options in a <select>.",
    schema: z.object({
      selector: z.string(),
      value: z.union([z.string(), z.array(z.string())]),
    }),
  },
);

const browserPressKey = tool(
  async ({ key, selector }) => {
    const page = await ensurePage();
    if (selector) {
      await page.locator(selector).press(key, { timeout: 10_000 });
      return `Pressed ${key} on ${selector}`;
    }
    await page.keyboard.press(key);
    return `Pressed ${key}`;
  },
  {
    name: "browser_press_key",
    description: "Press a key (e.g. 'Enter', 'Escape', 'Tab'), optionally focused on a selector.",
    schema: z.object({ key: z.string(), selector: z.string().optional() }),
  },
);

const browserDrag = tool(
  async ({ source, target }) => {
    const page = await ensurePage();
    await page.locator(source).dragTo(page.locator(target), { timeout: 15_000 });
    return `Dragged ${source} → ${target}`;
  },
  {
    name: "browser_drag",
    description: "Drag and drop: drag `source` element onto `target`.",
    schema: z.object({ source: z.string(), target: z.string() }),
  },
);

const browserFileUpload = tool(
  async ({ selector, files }) => {
    const page = await ensurePage();
    await page.locator(selector).setInputFiles(files);
    return `Uploaded ${files.length} file(s) to ${selector}`;
  },
  {
    name: "browser_file_upload",
    description: "Attach one or more local files to an <input type=file>.",
    schema: z.object({
      selector: z.string(),
      files: z.array(z.string()).min(1),
    }),
  },
);

const browserWaitFor = tool(
  async ({ selector, state, text, timeoutMs }) => {
    const page = await ensurePage();
    const timeout = timeoutMs ?? 15_000;
    if (text) {
      await page.waitForFunction(
        (t) => document.body.innerText.includes(t),
        text,
        { timeout },
      );
      return `Text "${text}" appeared`;
    }
    if (selector) {
      await page.locator(selector).waitFor({ state: state ?? "visible", timeout });
      return `Selector ${selector} reached state=${state ?? "visible"}`;
    }
    await page.waitForLoadState("networkidle", { timeout });
    return `networkidle reached`;
  },
  {
    name: "browser_wait_for",
    description:
      "Wait for a condition: either a selector reaching a state, or text appearing in the DOM, or (if neither given) networkidle.",
    schema: z.object({
      selector: z.string().optional(),
      state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
      text: z.string().optional(),
      timeoutMs: z.number().int().positive().max(60_000).optional(),
    }),
  },
);

const browserHandleDialog = tool(
  async ({ action, promptText }) => {
    armDialog(action, promptText);
    return `Dialog will be ${action}${promptText ? ` with "${promptText}"` : ""} when it next appears`;
  },
  {
    name: "browser_handle_dialog",
    description:
      "Pre-arm how the next JS dialog (alert/confirm/prompt) should be handled. Call this BEFORE the action that triggers the dialog.",
    schema: z.object({
      action: z.enum(["accept", "dismiss"]),
      promptText: z.string().optional(),
    }),
  },
);

// --- Inspection -------------------------------------------------------------

const browserSnapshot = tool(
  async () => captureSnapshot(await ensurePage()),
  {
    name: "browser_snapshot",
    description:
      "Return a condensed snapshot of the current page: URL, title, and a list of interactive elements with their discovered selectors. Use this to find selectors.",
    schema: z.object({}),
  },
);

const browserGenerateLocator = tool(
  async ({ selector }) => generateLocator(await ensurePage(), selector),
  {
    name: "browser_generate_locator",
    description:
      "Given any selector that already matches one element, return Playwright's recommended locator (getByRole / getByLabel / getByTestId / ...) following SKILL.md §Selector Strategy.",
    schema: z.object({ selector: z.string() }),
  },
);

const browserConsoleMessages = tool(
  async () => consoleLog().slice(-50).join("\n") || "(no console messages)",
  {
    name: "browser_console_messages",
    description: "Last 50 browser console messages from the current session.",
    schema: z.object({}),
  },
);

const browserNetworkRequests = tool(
  async ({ urlContains, limit }) => {
    const entries = networkLog()
      .filter((e) => !urlContains || e.url.includes(urlContains))
      .slice(-(limit ?? 50));
    if (entries.length === 0) return "(no network entries)";
    return entries
      .map((e) =>
        `${e.type === "response" ? "<-" : "->"} ${e.method} ${e.status ?? "--- "} ${e.url}`,
      )
      .join("\n");
  },
  {
    name: "browser_network_requests",
    description:
      "List recent network requests/responses on the page, optionally filtered by URL substring.",
    schema: z.object({
      urlContains: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
  },
);

const browserEvaluate = tool(
  async ({ expression }) => {
    const page = await ensurePage();
    const value = await page.evaluate((src) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => { ${src} })()`);
      return fn();
    }, expression);
    return JSON.stringify(value).slice(0, 4000);
  },
  {
    name: "browser_evaluate",
    description:
      "Run a JavaScript expression in the page context. The expression may be a single expression or a block that returns a value. JSON-stringified.",
    schema: z.object({
      expression: z
        .string()
        .describe("JS expression/body. Example: `return document.title;`"),
    }),
  },
);

const browserRunCode = tool(
  async ({ code }) => {
    const page = await ensurePage();
    // Same as evaluate but clarifies intent: the model can use `document.*`
    // to probe DOM / page state. Kept separate for prompt readability.
    const value = await page.evaluate((src) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => { ${src} })()`);
      return fn();
    }, code);
    return JSON.stringify(value).slice(0, 4000);
  },
  {
    name: "browser_run_code",
    description:
      "Run a multi-line JS snippet in the page context. Alias of browser_evaluate with a wider intent: probe DOM, compute counts, etc.",
    schema: z.object({ code: z.string() }),
  },
);

const browserTakeScreenshot = tool(
  async ({ path: maybePath, fullPage }) => {
    const page = await ensurePage();
    const outPath =
      maybePath ??
      path.join(os.tmpdir(), `pw-agent-${Date.now()}.png`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, fullPage: fullPage ?? false });
    return `Screenshot saved: ${outPath}`;
  },
  {
    name: "browser_take_screenshot",
    description:
      "Screenshot the current page to disk. Returns the absolute path so you can reference it.",
    schema: z.object({
      path: z.string().optional(),
      fullPage: z.boolean().optional(),
    }),
  },
);

// --- Verification -----------------------------------------------------------

const browserVerifyElementVisible = tool(
  async ({ selector }) => {
    const page = await ensurePage();
    const visible = await page.locator(selector).isVisible().catch(() => false);
    return visible ? `VISIBLE: ${selector}` : `NOT_VISIBLE: ${selector}`;
  },
  {
    name: "browser_verify_element_visible",
    description: "Assert (without throwing) whether a selector is currently visible.",
    schema: z.object({ selector: z.string() }),
  },
);

const browserVerifyListVisible = tool(
  async ({ selectors }) => {
    const page = await ensurePage();
    const lines: string[] = [];
    for (const sel of selectors) {
      const v = await page.locator(sel).isVisible().catch(() => false);
      lines.push(`${v ? "✓" : "✗"} ${sel}`);
    }
    return lines.join("\n");
  },
  {
    name: "browser_verify_list_visible",
    description: "Check visibility of each selector and return a ✓/✗ list.",
    schema: z.object({ selectors: z.array(z.string()).min(1) }),
  },
);

const browserVerifyTextVisible = tool(
  async ({ text, exact }) => {
    const page = await ensurePage();
    const locator = exact
      ? page.getByText(text, { exact: true })
      : page.getByText(text);
    const count = await locator.count();
    const visible = count > 0 && (await locator.first().isVisible().catch(() => false));
    return visible ? `VISIBLE: "${text}" (matches=${count})` : `NOT_VISIBLE: "${text}"`;
  },
  {
    name: "browser_verify_text_visible",
    description: "Check whether visible text containing the given string is present.",
    schema: z.object({ text: z.string(), exact: z.boolean().optional() }),
  },
);

const browserVerifyValue = tool(
  async ({ selector, expected }) => {
    const page = await ensurePage();
    const actual = await page.locator(selector).inputValue().catch(() => null);
    if (actual === null) return `NOT_FOUND: ${selector}`;
    return actual === expected
      ? `MATCH: ${selector} = ${JSON.stringify(actual)}`
      : `MISMATCH: ${selector} got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
  },
  {
    name: "browser_verify_value",
    description: "Check the current value of a form field against an expected string.",
    schema: z.object({ selector: z.string(), expected: z.string() }),
  },
);

// --- Storage / Cookies ------------------------------------------------------

const browserCookieGet = tool(
  async ({ name, url }) => {
    const ctx = context();
    if (!ctx) return "(browser not open)";
    const cookies = await ctx.cookies(url);
    const filtered = name ? cookies.filter((c) => c.name === name) : cookies;
    return filtered.length === 0 ? "(no cookies)" : JSON.stringify(filtered, null, 2);
  },
  {
    name: "browser_cookie_get",
    description:
      "Read cookies from the current browser context, optionally filtered by name and/or URL.",
    schema: z.object({ name: z.string().optional(), url: z.string().url().optional() }),
  },
);

const browserStorageState = tool(
  async () => {
    const ctx = context();
    if (!ctx) return "(browser not open)";
    const state = await ctx.storageState();
    return JSON.stringify(state).slice(0, 6000);
  },
  {
    name: "browser_storage_state",
    description:
      "Return the full browser storage state (cookies + localStorage). JSON, truncated at 6k chars.",
    schema: z.object({}),
  },
);

const browserSetStorageState = tool(
  async ({ cookies }) => {
    const ctx = context();
    if (!ctx) return "(browser not open — call browser_navigate first)";
    await ctx.addCookies(cookies);
    return `Added ${cookies.length} cookie(s)`;
  },
  {
    name: "browser_set_storage_state",
    description:
      "Inject cookies into the current browser context (useful for pre-authenticated sessions).",
    schema: z.object({
      cookies: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
            domain: z.string().optional(),
            path: z.string().optional(),
            url: z.string().url().optional(),
            expires: z.number().optional(),
            httpOnly: z.boolean().optional(),
            secure: z.boolean().optional(),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
          }),
        )
        .min(1),
    }),
  },
);

// --- Lifecycle --------------------------------------------------------------

const browserClose = tool(
  async () => {
    await closeBrowser();
    return "Browser closed";
  },
  {
    name: "browser_close",
    description:
      "Close the shared browser. Do NOT call this mid-flow — it resets all state. The graph closes the browser automatically after the agent returns.",
    schema: z.object({}),
  },
);

export const browserTools = [
  // Navigation
  browserNavigate,
  browserNavigateBack,
  // Interaction
  browserClick,
  browserHover,
  browserType,
  browserSelectOption,
  browserPressKey,
  browserDrag,
  browserFileUpload,
  browserWaitFor,
  browserHandleDialog,
  // Inspection
  browserSnapshot,
  browserGenerateLocator,
  browserConsoleMessages,
  browserNetworkRequests,
  browserEvaluate,
  browserRunCode,
  browserTakeScreenshot,
  // Verification
  browserVerifyElementVisible,
  browserVerifyListVisible,
  browserVerifyTextVisible,
  browserVerifyValue,
  // Storage
  browserCookieGet,
  browserStorageState,
  browserSetStorageState,
  // Lifecycle
  browserClose,
];
