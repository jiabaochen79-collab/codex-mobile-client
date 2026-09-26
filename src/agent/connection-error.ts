export type ConnectionStage = 'credentials' | 'register' | 'save' | 'connect';

export class ConnectionHttpError extends Error {
  constructor(readonly status: number) { super('Server request failed'); }
}

export function connectionFailure(stage: ConnectionStage, error: unknown) {
  const codes: string[] = [];
  function collect(value: any, depth = 0) {
    if (!value || depth > 4) return;
    if (typeof value.code === 'string') codes.push(value.code);
    if (value.name === 'TimeoutError' || value.name === 'AbortError') codes.push('ETIMEDOUT');
    collect(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 8)) collect(child, depth + 1);
  }
  collect(error);
  let code = 'NETWORK'; let message = '服务器连接未建立，正在自动重试；请提供错误编号以便排查。';
  if (stage === 'credentials' || stage === 'save') {
    code = stage === 'save' ? 'CREDENTIAL_SAVE' : 'CREDENTIAL_READ';
    message = stage === 'save' ? '设备凭据保存失败，请检查安全软件拦截、磁盘空间及目录权限。' : '设备凭据读取失败，请使用原 Windows 用户运行，勿复制其他电脑的数据目录。';
  } else if (error instanceof ConnectionHttpError) {
    code = `HTTP_${error.status}`;
    message = error.status === 429 ? '设备注册过于频繁，请稍后重试。' : error.status === 401 || error.status === 403 ? '服务器拒绝连接，请核对服务器配置及网络访问限制。' : `服务器请求失败（HTTP ${error.status}），正在自动重试。`;
  } else if (codes.some(value => ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'].includes(value))) {
    code = 'TLS_DATE'; message = '证书有效期校验失败，请检查电脑日期和时间；时间正确时请联系管理员。';
  } else if (codes.some(value => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_SIGNATURE_FAILURE'].includes(value))) {
    code = 'TLS_CERT'; message = '服务器证书验证失败，请检查网络代理或联系管理员。';
  } else if (codes.some(value => ['ENOTFOUND', 'EAI_AGAIN'].includes(value))) {
    code = 'DNS'; message = '服务器域名解析失败，请检查网络和 DNS 设置。';
  } else if (codes.some(value => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(value))) {
    code = 'TIMEOUT'; message = '连接服务器超时，请检查网络、防火墙或代理设置。';
  } else if (codes.includes('ECONNREFUSED')) {
    code = 'REFUSED'; message = '服务器连接被拒绝，请检查防火墙或联系管理员。';
  } else if (codes.some(value => ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'].includes(value))) {
    code = 'CONNECTION_RESET'; message = '与服务器的连接意外中断，正在重试；请联系管理员核查连接链路。';
  } else if (stage === 'register' && (error instanceof SyntaxError || (error as any)?.name === 'ZodError')) {
    code = 'REGISTER_RESPONSE'; message = '设备注册返回异常，请检查网络登录页或服务器配置。';
  }
  return { stage, code, message };
}
