/** Browser-side JSON fetch for the BFF with a typed error. */
export class ApiError extends Error { constructor(public status: number, public body: unknown) { super(`HTTP ${status}`); } }
export async function apiGet<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
export async function apiPost<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}
