const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Per-attempt timeout so a hung provider cannot wedge a run at "running" forever. */
export const PROVIDER_TIMEOUT_MS = 30_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw new DOMException(`${label} aborted`, 'AbortError');
}

/**
 * POSTs JSON and returns the parsed body. Transient statuses are retried with backoff.
 * Model requests are idempotent; browser mutations are never retried through here.
 * Each attempt has a timeout, and an external AbortSignal (Stop) cancels waiting.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: { retries?: number; label?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<any> {
  const retries = options.retries ?? 3;
  const label = options.label || 'Model provider';
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const signal = options.signal;

  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal, label);
    let response: Response;
    const attemptController = new AbortController();
    const onExternalAbort = () => attemptController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timeout = setTimeout(() => attemptController.abort(), timeoutMs);
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: attemptController.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onExternalAbort);
      if (err?.name === 'AbortError') {
        // Stop (external signal) must not be retried or relabeled as a connection
        // failure; a plain timeout is reported so the run ends with an error.
        if (signal?.aborted) throw err;
        if (attempt < retries) {
          await sleep(800 * 2 ** attempt, signal);
          continue;
        }
        throw new Error(`${label} timed out after ${timeoutMs}ms; no action executed.`);
      }
      // fetch itself throwing (DNS failure, connection reset, "Failed to fetch" from a
      // service worker) is retried the same as a transient status: model requests are
      // idempotent, and the body sent above is a fresh JSON string per attempt, not a
      // stream a prior attempt could have consumed, so resending it is safe.
      if (attempt < retries) {
        await sleep(800 * 2 ** attempt, signal); // 0.8 s, 1.6 s, 3.2 s: same backoff as transient statuses
        continue;
      }
      throw new Error(`${label} connection failed (${err?.message || String(err)}); no action executed.`);
    }
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);

    if (TRANSIENT_STATUSES.has(response.status) && attempt < retries) {
      await sleep(800 * 2 ** attempt, signal); // 0.8 s, 1.6 s, 3.2 s: shared text-model routes rate-limit briefly
      continue;
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        // ignore unreadable body
      }
      throw new Error(`${label} error (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
    }

    return response.json();
  }
}
