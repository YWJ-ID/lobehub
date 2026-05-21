import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      ALIPAY_APP_ID?: string;
      ALIPAY_PRIVATE_KEY_PATH?: string;
      ALIPAY_GATEWAY_URL?: string;
    }
  }
}

export const getAlipayConfig = () => {
  return createEnv({
    server: {
      ALIPAY_APP_ID: z.string().optional(),
      ALIPAY_PRIVATE_KEY_PATH: z.string().optional(),
      ALIPAY_PUBLIC_KEY_PATH: z.string().optional(),
      ALIPAY_GATEWAY_URL: z.string().url().optional(),
      ALIPAY_SELLER_ID: z.string().optional(),
    },
    runtimeEnv: {
      ALIPAY_APP_ID: process.env.ALIPAY_APP_ID,
      ALIPAY_PRIVATE_KEY_PATH: process.env.ALIPAY_PRIVATE_KEY_PATH,
      ALIPAY_PUBLIC_KEY_PATH: process.env.ALIPAY_PUBLIC_KEY_PATH,
      ALIPAY_GATEWAY_URL: process.env.ALIPAY_GATEWAY_URL,
      ALIPAY_SELLER_ID: process.env.ALIPAY_SELLER_ID,
    },
  });
};

export const alipayEnv = getAlipayConfig();
