export async function isReachable(
  url: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

export async function waitUntilReachable(
  url: string,
  opts: { totalMs: number; stepMs?: number } = { totalMs: 120_000 },
): Promise<boolean> {
  const step = opts.stepMs ?? 5_000;
  const deadline = Date.now() + opts.totalMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}
