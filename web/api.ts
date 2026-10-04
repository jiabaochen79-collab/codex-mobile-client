export async function api(path: string, body?: unknown, headers?: Record<string, string>, method?: 'GET' | 'POST' | 'PUT' | 'DELETE') {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const readOnly = verb === 'GET';
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(path, { method: verb, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const result = await response.json().catch(() => undefined);
      if (!response.ok) throw Object.assign(new Error(result?.error?.message ?? '连接失败，请稍后重试。'), { code: result?.error?.code, status: response.status });
      if (result === undefined || !response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('服务器返回异常，请稍后重试。'), { code: 'INVALID_RESPONSE' });
      return result;
    } catch (e: any) {
      const transient = e instanceof TypeError || ['TimeoutError', 'AbortError'].includes(e?.name) || [502, 503, 504].includes(e?.status);
      if (readOnly && attempt === 0 && transient) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
      if (!e?.status && transient) throw Object.assign(new Error(readOnly ? '网络暂时不可用，请恢复连接后重试。' : '未收到操作确认，请先核对结果，勿重复提交。'), { code: readOnly ? 'NETWORK' : 'OUTCOME_UNKNOWN' });
      throw e;
    }
  }
}
