export async function api(path: string, body?: unknown, headers?: Record<string, string>, method?: 'GET' | 'POST' | 'PUT' | 'DELETE') {
  const response = await fetch(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message ?? '连接失败，请稍后重试。'), { code: result.error?.code, status: response.status });
  return result;
}
