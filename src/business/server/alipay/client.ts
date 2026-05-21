import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { alipayEnv } from '@/envs/alipay';

export interface AlipayPagePayParams {
  out_trade_no: string;
  total_amount: string;
  subject: string;
  body?: string;
  product_code?: string;
  return_url?: string;
  notify_url?: string;
}

export interface AlipayErrorResponse {
  code: string;
  msg: string;
  sub_code?: string;
  sub_msg?: string;
}

let cachedPrivateKey: string | null = null;
let cachedPublicKey: string | null = null;

const loadPrivateKey = (privateKeyPath: string): string => {
  if (cachedPrivateKey !== null) {
    return cachedPrivateKey;
  }

  try {
    cachedPrivateKey = readFileSync(privateKeyPath, 'utf-8');
    return cachedPrivateKey;
  } catch (error) {
    throw new Error(
      `Failed to load Alipay private key from ${privateKeyPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const loadPublicKey = (publicKeyPath: string): string => {
  if (cachedPublicKey !== null) {
    return cachedPublicKey;
  }

  try {
    cachedPublicKey = readFileSync(publicKeyPath, 'utf-8');
    return cachedPublicKey;
  } catch (error) {
    throw new Error(
      `Failed to load Alipay public key from ${publicKeyPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const getBeijingTimestamp = (): string => {
  const now = new Date();
  const offsetMinutes = now.getTimezoneOffset() + 480;
  const beijing = new Date(now.getTime() + offsetMinutes * 60 * 1000);

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${beijing.getFullYear()}-${pad(beijing.getMonth() + 1)}-${pad(beijing.getDate())} ${pad(beijing.getHours())}:${pad(beijing.getMinutes())}:${pad(beijing.getSeconds())}`;
};

/**
 * Sign Alipay parameters with RSA2 (SHA256 with RSA).
 *
 * @param params - The parameters to sign. Empty values and the `sign` key itself are excluded.
 * @param privateKey - RSA private key in PEM format.
 * @returns Base64-encoded signature.
 */
export const signParams = (params: Record<string, string>, privateKey: string): string => {
  const filtered = Object.entries(params)
    .filter(([key, value]) => key !== 'sign' && value !== '' && value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b, 'en'));

  const content = filtered.map(([key, value]) => `${key}=${value}`).join('&');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  return signer.sign(privateKey, 'base64');
};

/**
 * Build a signed Alipay PC Web payment URL.
 *
 * Uses `alipay.trade.page.pay` with product code `FAST_INSTANT_TRADE_PAY`.
 *
 * @param params - Payment parameters.
 * @returns Full gateway URL with query parameters.
 */
export const buildPagePayUrl = (params: AlipayPagePayParams): string => {
  const gateway = alipayEnv.ALIPAY_GATEWAY_URL || 'https://openapi.alipay.com/gateway.do';
  const appId = alipayEnv.ALIPAY_APP_ID;
  const privateKeyPath = alipayEnv.ALIPAY_PRIVATE_KEY_PATH;

  if (!appId) {
    throw new Error('ALIPAY_APP_ID is not configured');
  }

  if (!privateKeyPath) {
    throw new Error('ALIPAY_PRIVATE_KEY_PATH is not configured');
  }

  const privateKey = loadPrivateKey(privateKeyPath);

  const baseParams: Record<string, string> = {
    app_id: appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: getBeijingTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify({
      out_trade_no: params.out_trade_no,
      total_amount: params.total_amount,
      subject: params.subject,
      body: params.body,
      product_code: params.product_code || 'FAST_INSTANT_TRADE_PAY',
    }),
  };

  if (params.return_url) {
    baseParams.return_url = params.return_url;
  }

  if (params.notify_url) {
    baseParams.notify_url = params.notify_url;
  }

  baseParams.sign = signParams(baseParams, privateKey);

  const url = new URL(gateway);
  Object.entries(baseParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
};

/**
 * Verify an Alipay notify signature with RSA2 (SHA256 with RSA).
 *
 * @param params - The parameters received from Alipay (sign excluded).
 * @param signature - The Base64-encoded signature to verify.
 * @param publicKey - RSA public key in PEM format.
 * @returns True if the signature is valid.
 */
export const verifyNotifySignature = (
  params: Record<string, string>,
  signature: string,
  publicKey: string,
): boolean => {
  const filtered = Object.entries(params)
    .filter(
      ([key, value]) =>
        key !== 'sign' && key !== 'sign_type' && value !== '' && value !== undefined && value !== null,
    )
    .sort(([a], [b]) => a.localeCompare(b, 'en'));

  const content = filtered.map(([key, value]) => `${key}=${value}`).join('&');

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(content, 'utf8');
  return verifier.verify(publicKey, signature, 'base64');
};

/**
 * Load the Alipay public key from the configured path.
 *
 * @returns The public key PEM string.
 */
export const getAlipayPublicKey = (): string | undefined => {
  const publicKeyPath = alipayEnv.ALIPAY_PUBLIC_KEY_PATH;
  if (!publicKeyPath) return undefined;
  return loadPublicKey(publicKeyPath);
};

/**
 * Parse an Alipay error response.
 *
 * @param data - Raw response data.
 * @returns Structured error object, or null if the data is not a valid error response.
 */
export const parseNotifyResponse = (data: unknown): AlipayErrorResponse | null => {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const record = data as Record<string, unknown>;

  if (typeof record.code !== 'string' || typeof record.msg !== 'string') {
    return null;
  }

  return {
    code: record.code,
    msg: record.msg,
    sub_code: typeof record.sub_code === 'string' ? record.sub_code : undefined,
    sub_msg: typeof record.sub_msg === 'string' ? record.sub_msg : undefined,
  };
};
