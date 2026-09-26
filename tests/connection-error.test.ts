import { describe, expect, it } from 'vitest';
import { ConnectionHttpError, connectionFailure } from '../src/agent/connection-error.js';

describe('safe connection failure details', () => {
  it.each([
    ['ENOTFOUND', 'DNS'], ['EAI_AGAIN', 'DNS'], ['ETIMEDOUT', 'TIMEOUT'],
    ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'], ['CERT_HAS_EXPIRED', 'TLS_DATE'],
    ['CERT_NOT_YET_VALID', 'TLS_DATE'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_CERT'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'TLS_CERT'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_CERT'],
    ['ECONNREFUSED', 'REFUSED'],
    ['ECONNRESET', 'CONNECTION_RESET'], ['UND_ERR_SOCKET', 'CONNECTION_RESET'], ['EPIPE', 'CONNECTION_RESET'],
  ])('classifies nested fetch error %s without exposing its contents', (code, expected) => {
    const failure = connectionFailure('register', new TypeError('fetch failed SECRET', { cause: Object.assign(new Error('secret URL'), { code }) }));
    expect(failure).toMatchObject({ stage: 'register', code: expected });
    expect(JSON.stringify(failure)).not.toMatch(/SECRET|secret URL/);
  });
  it('handles aggregate network failures and abort timeouts', () => {
    expect(connectionFailure('connect', new AggregateError([Object.assign(new Error(), { code: 'ETIMEDOUT' })])).code).toBe('TIMEOUT');
    expect(connectionFailure('register', new DOMException('secret', 'TimeoutError')).code).toBe('TIMEOUT');
  });
  it('separates credential storage from network problems', () => {
    expect(connectionFailure('save', new Error('private credential')).code).toBe('CREDENTIAL_SAVE');
    expect(connectionFailure('credentials', new Error('private credential')).code).toBe('CREDENTIAL_READ');
    expect(connectionFailure('register', new SyntaxError('private body')).code).toBe('REGISTER_RESPONSE');
    expect(connectionFailure('register', new ConnectionHttpError(429)).code).toBe('HTTP_429');
  });
});
