import type { Browser, BrowserContext, Dialog, Page, Request } from "playwright";

interface NetworkEntry {
  method: string;
  url: string;
  status: number | null;
  type: "request" | "response";
  timestamp: string;
}

interface State {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  consoleLog: string[];
  networkLog: NetworkEntry[];
  dialogAction: "accept" | "dismiss" | null;
  dialogPromptText: string | null;
}

const state: State = {
  browser: null,
  context: null,
  page: null,
  consoleLog: [],
  networkLog: [],
  dialogAction: null,
  dialogPromptText: null,
};

function pushConsole(msg: string): void {
  state.consoleLog.push(msg);
  if (state.consoleLog.length > 200) state.consoleLog.shift();
}

function pushNetwork(entry: NetworkEntry): void {
  state.networkLog.push(entry);
  if (state.networkLog.length > 200) state.networkLog.shift();
}

async function handleDialog(dialog: Dialog): Promise<void> {
  const action = state.dialogAction ?? "dismiss";
  state.dialogAction = null;
  try {
    if (action === "accept") {
      await dialog.accept(state.dialogPromptText ?? undefined);
    } else {
      await dialog.dismiss();
    }
  } catch {
    // Dialog already handled.
  }
  state.dialogPromptText = null;
}

/** Lazy Playwright singleton — one Chromium across all tool calls in a run. */
export async function ensurePage(): Promise<Page> {
  if (state.page) return state.page;
  const { chromium } = await import("playwright");
  state.browser = await chromium.launch({ headless: true });
  state.context = await state.browser.newContext();
  state.page = await state.context.newPage();

  state.page.on("console", (msg) =>
    pushConsole(`[${msg.type()}] ${msg.text()}`),
  );
  state.page.on("request", (req: Request) =>
    pushNetwork({
      method: req.method(),
      url: req.url(),
      status: null,
      type: "request",
      timestamp: new Date().toISOString(),
    }),
  );
  state.page.on("response", (res) =>
    pushNetwork({
      method: res.request().method(),
      url: res.url(),
      status: res.status(),
      type: "response",
      timestamp: new Date().toISOString(),
    }),
  );
  state.page.on("dialog", (d) => {
    void handleDialog(d);
  });
  return state.page;
}

export async function closeBrowser(): Promise<void> {
  try { await state.page?.close(); } catch { /* ignore */ }
  try { await state.context?.close(); } catch { /* ignore */ }
  try { await state.browser?.close(); } catch { /* ignore */ }
  state.browser = null;
  state.context = null;
  state.page = null;
  state.consoleLog.length = 0;
  state.networkLog.length = 0;
}

export function consoleLog(): readonly string[] {
  return state.consoleLog;
}

export function networkLog(): readonly NetworkEntry[] {
  return state.networkLog;
}

export function armDialog(action: "accept" | "dismiss", promptText?: string): void {
  state.dialogAction = action;
  state.dialogPromptText = promptText ?? null;
}

export function context(): BrowserContext | null {
  return state.context;
}
