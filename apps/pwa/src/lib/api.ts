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

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
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
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}
