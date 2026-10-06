export function errorText(raw: unknown) {
  return typeof raw === 'string' ? raw.split(/[\r\n]/, 1)[0].replace(/[\x00-\x1f\x7f]/g, '').replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[redacted]').replace(/["']?\b(password|passwd|authorization|cookie|api[_-]?key|token|secret)["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1=[redacted]').trim().slice(0, 400) : '';
}
