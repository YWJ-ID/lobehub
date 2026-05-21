// @vitest-environment node
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('signParams', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  it('produces a base64 signature for sorted params', async () => {
    const { signParams } = await import('../client');
    const params = { b: '2', a: '1' };
    const signature = signParams(params, privateKey);
    expect(typeof signature).toBe('string');
    expect(Buffer.from(signature, 'base64').length).toBeGreaterThan(0);

    const content = 'a=1&b=2';
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    expect(verifier.verify(publicKey, signature, 'base64')).toBe(true);
  });

  it('excludes sign and empty values', async () => {
    const { signParams } = await import('../client');
    const params: Record<string, string> = {
      a: '1',
      sign: 'should-be-excluded',
      b: '',
      c: '3',
    };
    const signature = signParams(params, privateKey);

    const content = 'a=1&c=3';
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    expect(verifier.verify(publicKey, signature, 'base64')).toBe(true);
  });

  it('sorts params deterministically with en locale', async () => {
    const { signParams } = await import('../client');
    const params = { b: '2', a: '1', c: '3' };
    const signature = signParams(params, privateKey);

    const content = 'a=1&b=2&c=3';
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    expect(verifier.verify(publicKey, signature, 'base64')).toBe(true);
  });
});

describe('buildPagePayUrl', () => {
  let tmpDir: string;
  let privateKeyPath: string;
  let privateKey: string;
  let publicKey: string;
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    vi.resetModules();
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
    tmpDir = mkdtempSync(join(tmpdir(), 'alipay-test-'));
    privateKeyPath = join(tmpDir, 'private.pem');
    writeFileSync(privateKeyPath, privateKey);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('constructs a signed PC Web payment URL', async () => {
    process.env.ALIPAY_APP_ID = 'test_app_id';
    process.env.ALIPAY_PRIVATE_KEY_PATH = privateKeyPath;
    process.env.ALIPAY_GATEWAY_URL = 'https://openapi.alipaydev.com/gateway.do';

    const { buildPagePayUrl } = await import('../client');
    const url = buildPagePayUrl({
      out_trade_no: 'ORDER_123',
      total_amount: '99.99',
      subject: 'Test Product',
      return_url: 'https://example.com/return',
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://openapi.alipaydev.com/gateway.do');
    expect(parsed.searchParams.get('app_id')).toBe('test_app_id');
    expect(parsed.searchParams.get('method')).toBe('alipay.trade.page.pay');
    expect(parsed.searchParams.get('sign_type')).toBe('RSA2');
    expect(parsed.searchParams.get('return_url')).toBe('https://example.com/return');

    const bizContent = JSON.parse(parsed.searchParams.get('biz_content') || '{}');
    expect(bizContent.out_trade_no).toBe('ORDER_123');
    expect(bizContent.total_amount).toBe('99.99');
    expect(bizContent.subject).toBe('Test Product');
    expect(bizContent.product_code).toBe('FAST_INSTANT_TRADE_PAY');

    const sign = parsed.searchParams.get('sign') || '';
    expect(sign.length).toBeGreaterThan(0);

    const paramsForVerify: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      if (key !== 'sign') {
        paramsForVerify[key] = value;
      }
    });

    const filtered = Object.entries(paramsForVerify)
      .filter(([key, value]) => key !== 'sign' && value !== '' && value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b, 'en'));
    const content = filtered.map(([key, value]) => `${key}=${value}`).join('&');

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    expect(verifier.verify(publicKey, sign, 'base64')).toBe(true);
  });

  it('caches the private key after first load', async () => {
    process.env.ALIPAY_APP_ID = 'test_app_id';
    process.env.ALIPAY_PRIVATE_KEY_PATH = privateKeyPath;

    const { buildPagePayUrl } = await import('../client');

    buildPagePayUrl({
      out_trade_no: 'ORDER_1',
      total_amount: '99.99',
      subject: 'Test',
    });

    rmSync(privateKeyPath);

    const url = buildPagePayUrl({
      out_trade_no: 'ORDER_2',
      total_amount: '88.88',
      subject: 'Test 2',
    });
    expect(url).toContain('ORDER_2');
  });

  it('throws when app_id is missing', async () => {
    delete process.env.ALIPAY_APP_ID;
    process.env.ALIPAY_PRIVATE_KEY_PATH = privateKeyPath;

    const { buildPagePayUrl } = await import('../client');
    expect(() =>
      buildPagePayUrl({
        out_trade_no: 'ORDER_123',
        total_amount: '99.99',
        subject: 'Test Product',
      }),
    ).toThrow('ALIPAY_APP_ID is not configured');
  });

  it('throws when private key path is missing', async () => {
    process.env.ALIPAY_APP_ID = 'test_app_id';
    delete process.env.ALIPAY_PRIVATE_KEY_PATH;

    const { buildPagePayUrl } = await import('../client');
    expect(() =>
      buildPagePayUrl({
        out_trade_no: 'ORDER_123',
        total_amount: '99.99',
        subject: 'Test Product',
      }),
    ).toThrow('ALIPAY_PRIVATE_KEY_PATH is not configured');
  });

  it('throws a domain-specific error when private key file is unreadable', async () => {
    process.env.ALIPAY_APP_ID = 'test_app_id';
    process.env.ALIPAY_PRIVATE_KEY_PATH = join(tmpDir, 'non-existent.pem');

    const { buildPagePayUrl } = await import('../client');
    expect(() =>
      buildPagePayUrl({
        out_trade_no: 'ORDER_123',
        total_amount: '99.99',
        subject: 'Test Product',
      }),
    ).toThrow('Failed to load Alipay private key');
  });

  it('handles URL-unsafe characters in params', async () => {
    process.env.ALIPAY_APP_ID = 'test_app_id';
    process.env.ALIPAY_PRIVATE_KEY_PATH = privateKeyPath;
    process.env.ALIPAY_GATEWAY_URL = 'https://openapi.alipaydev.com/gateway.do';

    const { buildPagePayUrl } = await import('../client');
    const url = buildPagePayUrl({
      out_trade_no: 'ORDER_123',
      total_amount: '99.99',
      subject: 'Test & Product = Special % 测试',
      body: 'A=B&C=D',
      return_url: 'https://example.com/return?a=1&b=2',
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('return_url')).toBe('https://example.com/return?a=1&b=2');

    const bizContent = JSON.parse(parsed.searchParams.get('biz_content') || '{}');
    expect(bizContent.subject).toBe('Test & Product = Special % 测试');
    expect(bizContent.body).toBe('A=B&C=D');

    const sign = parsed.searchParams.get('sign') || '';
    expect(sign.length).toBeGreaterThan(0);

    const paramsForVerify: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      if (key !== 'sign') {
        paramsForVerify[key] = value;
      }
    });

    const filtered = Object.entries(paramsForVerify)
      .filter(([key, value]) => key !== 'sign' && value !== '' && value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b, 'en'));
    const content = filtered.map(([key, value]) => `${key}=${value}`).join('&');

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    expect(verifier.verify(publicKey, sign, 'base64')).toBe(true);
  });

  it('uses Beijing time (UTC+8) for timestamp', async () => {
    process.env.ALIPAY_APP_ID = 'test_app_id';
    process.env.ALIPAY_PRIVATE_KEY_PATH = privateKeyPath;

    const { buildPagePayUrl } = await import('../client');
    const url = buildPagePayUrl({
      out_trade_no: 'ORDER_123',
      total_amount: '99.99',
      subject: 'Test Product',
    });

    const parsed = new URL(url);
    const timestamp = parsed.searchParams.get('timestamp') || '';
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const timestampDate = new Date(timestamp.replace(' ', 'T') + '+08:00');
    const now = new Date();
    const diff = Math.abs(now.getTime() - timestampDate.getTime());
    expect(diff).toBeLessThan(60 * 1000);
  });
});

describe('verifyNotifySignature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  it('returns true for a valid signature', async () => {
    const { verifyNotifySignature } = await import('../client');
    const params = { b: '2', a: '1' };
    const content = 'a=1&b=2';
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(content, 'utf8');
    const signature = signer.sign(privateKey, 'base64');

    expect(verifyNotifySignature(params, signature, publicKey)).toBe(true);
  });

  it('excludes sign and sign_type from verification content', async () => {
    const { verifyNotifySignature } = await import('../client');
    const params = {
      a: '1',
      sign: 'ignored',
      sign_type: 'RSA2',
      b: '2',
    };
    const content = 'a=1&b=2';
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(content, 'utf8');
    const signature = signer.sign(privateKey, 'base64');

    expect(verifyNotifySignature(params, signature, publicKey)).toBe(true);
  });

  it('returns false for an invalid signature', async () => {
    const { verifyNotifySignature } = await import('../client');
    expect(verifyNotifySignature({ a: '1' }, 'invalid-signature', publicKey)).toBe(false);
  });

  it('returns false when params are tampered', async () => {
    const { verifyNotifySignature } = await import('../client');
    const params = { a: '1', b: '2' };
    const content = 'a=1&b=2';
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(content, 'utf8');
    const signature = signer.sign(privateKey, 'base64');

    expect(verifyNotifySignature({ a: '1', b: '3' }, signature, publicKey)).toBe(false);
  });
});

describe('parseNotifyResponse', () => {
  it('parses a valid error response', async () => {
    const { parseNotifyResponse } = await import('../client');
    const result = parseNotifyResponse({
      code: '40002',
      msg: 'Invalid Arguments',
      sub_code: 'isv.invalid-app-id',
      sub_msg: 'App ID无效',
    });
    expect(result).toEqual({
      code: '40002',
      msg: 'Invalid Arguments',
      sub_code: 'isv.invalid-app-id',
      sub_msg: 'App ID无效',
    });
  });

  it('returns null for non-object input', async () => {
    const { parseNotifyResponse } = await import('../client');
    expect(parseNotifyResponse(null)).toBeNull();
    expect(parseNotifyResponse('string')).toBeNull();
    expect(parseNotifyResponse(123)).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    const { parseNotifyResponse } = await import('../client');
    expect(parseNotifyResponse({ code: '40002' })).toBeNull();
    expect(parseNotifyResponse({ msg: 'Error' })).toBeNull();
  });

  it('omits optional fields when not strings', async () => {
    const { parseNotifyResponse } = await import('../client');
    const result = parseNotifyResponse({
      code: '40002',
      msg: 'Invalid Arguments',
      sub_code: 123,
      sub_msg: null,
    });
    expect(result).toEqual({
      code: '40002',
      msg: 'Invalid Arguments',
      sub_code: undefined,
      sub_msg: undefined,
    });
  });
});
