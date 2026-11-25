// Thin REST client for the CarbonKhata API. The Vite dev server proxies /api to FastAPI on :8000.
export const TOKEN_KEY = 'ck_token';
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } };
export const setToken = (t: string) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; text?: boolean; noAuth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const t = getToken();
  if (t && !opts.noAuth) headers.Authorization = `Bearer ${t}`;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  let r: Response;
  try {
    r = await fetch(`/api/v1${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  } catch {
    throw new ApiError(0, 'Cannot reach the CarbonKhata server. Check that the API is running.');
  }
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j); } catch { /* not JSON */ }
    if (r.status === 401 && !opts.noAuth) { setToken(''); window.dispatchEvent(new Event('ck-signed-out')); }
    throw new ApiError(r.status, msg);
  }
  if (opts.text) return (await r.text()) as T;
  return (await r.json()) as T;
}

export const idemKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
