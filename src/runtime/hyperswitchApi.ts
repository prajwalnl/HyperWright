import { ENV } from "../env.js";
import type { Creds } from "../types.js";

/**
 * Hyperswitch backend API helpers used during session setup.
 *
 * The contract here MUST match `playwright-tests/support/commands.ts` in the
 * cloned repo — that file is the source of truth, and any drift surfaces as
 * "400 Bad Request" with no useful clue. Specifically:
 *   - `api-key: test_admin` header is required for signup_with_merchant_id
 *   - Body needs { email, password, company_name, name }
 */

export function backendBaseUrl(): string {
  return ENV.backend.healthUrl.replace(/\/health\/?$/, "");
}

/** Mirrors playwright-tests/support/helper.ts::generateDateTimeString. */
function generateDateTimeString(): string {
  const now = new Date();
  const randomSuffix = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return now.toISOString().replace(/[-:.T]/g, "").slice(0, 14) + randomSuffix;
}

export interface SignupResult {
  ok: boolean;
  status: number;
  body: string;
}

export async function signupWithMerchantId(
  creds: Creds,
  opts: { companyName?: string; name?: string; timeoutMs?: number } = {},
): Promise<SignupResult> {
  const url = `${backendBaseUrl()}/user/signup_with_merchant_id`;
  const body = {
    email: creds.email,
    password: creds.password,
    // Backend's company-name validator rejects hyphens and other non-alnum
    // chars — empirically `pw-<ts>` returns "Invalid Company Name" (UR_14).
    // Match the exact format the upstream playwright tests use:
    // YYYYMMDDHHMMSS + 4-digit random suffix (digits only).
    company_name: opts.companyName ?? generateDateTimeString(),
    name: opts.name ?? "Playwright_test_user",
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": "test_admin",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text };
  } catch (err) {
    return { ok: false, status: 0, body: (err as Error).message };
  }
}
