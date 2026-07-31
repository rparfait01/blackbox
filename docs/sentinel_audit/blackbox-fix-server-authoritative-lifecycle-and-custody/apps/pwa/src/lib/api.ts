/**
 * Thin API client (W8A). Wraps fetch against the Worker, attaches the Bearer
 * session token by default, and returns a typed `{ ok, status, data }` so callers
 * never throw on HTTP errors. Base URL is the build-time VITE_API_BASE_URL.
 */

import { API_BASE_URL } from './env';
import { getSessionToken } from './auth';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

/**
 * Hard ceiling on any single API call. Without it a stalled connection (common
 * on flaky mobile networks, and the server awaits SendGrid before answering the
 * signup POST) leaves the UI hanging with no feedback — the "tapped create,
 * nothing happened" failure. On timeout we surface status 0 so callers render a
 * plain "no connection" message instead of spinning forever.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.auth !== false) {
    const token = getSessionToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    // Network failure, CORS rejection, or timeout/abort — all surface as status 0
    // so the caller can show "No connection" rather than failing silently.
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}
