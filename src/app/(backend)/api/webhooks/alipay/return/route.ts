import { NextResponse } from 'next/server';

import { serverDB } from '@/database/server';
import { alipayEnv } from '@/envs/alipay';
import { getAlipayPublicKey, verifyNotifySignature } from '@/business/server/alipay/client';

const REDIRECT_SUCCESS = '/settings?tab=credits&status=success';
const REDIRECT_ERROR = '/settings?tab=credits&status=error';

export const GET = async (req: Request): Promise<NextResponse> => {
  try {
    const { searchParams } = new URL(req.url);
    const params: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      params[key] = value;
    });

    const signature = params.sign;
    const signType = params.sign_type;

    if (!signature) {
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    if (signType && signType !== 'RSA2') {
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const publicKey = getAlipayPublicKey();
    if (!publicKey) {
      console.error('[Alipay Return] ALIPAY_PUBLIC_KEY_PATH is not configured');
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const { sign: _sign, sign_type: _signType, ...verifyParams } = params;
    const isValid = verifyNotifySignature(verifyParams, signature, publicKey);
    if (!isValid) {
      console.warn('[Alipay Return] signature verification failed');
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const appId = params.app_id;
    if (!appId || appId !== alipayEnv.ALIPAY_APP_ID) {
      console.warn('[Alipay Return] app_id mismatch:', appId);
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const sellerId = alipayEnv.ALIPAY_SELLER_ID;
    if (sellerId && params.seller_id !== sellerId) {
      console.warn('[Alipay Return] seller_id mismatch:', params.seller_id);
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const outTradeNo = params.out_trade_no;
    if (!outTradeNo) {
      console.warn('[Alipay Return] missing out_trade_no');
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const tradeNo = params.trade_no;
    if (!tradeNo) {
      console.warn('[Alipay Return] missing trade_no');
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const notifyId = params.notify_id;
    if (!notifyId) {
      console.warn('[Alipay Return] missing notify_id');
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const notifyTime = params.notify_time;
    if (!notifyTime) {
      console.warn('[Alipay Return] missing notify_time');
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const tradeStatus = params.trade_status;
    if (!tradeStatus || (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED')) {
      console.warn('[Alipay Return] invalid or missing trade_status:', tradeStatus);
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const order = await serverDB.query.paymentOrders.findFirst({
      where: (table, { eq }) => eq(table.outTradeNo, outTradeNo),
    });

    if (!order) {
      console.warn('[Alipay Return] order not found:', outTradeNo);
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    if (order.provider !== 'alipay') {
      console.warn('[Alipay Return] provider mismatch:', order.provider);
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    const totalAmount = params.total_amount;
    const expectedAmount = (order.amountCents / 100).toFixed(2);
    if (totalAmount && totalAmount !== expectedAmount) {
      console.warn('[Alipay Return] total_amount mismatch:', totalAmount, 'expected:', expectedAmount);
      return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
    }

    return NextResponse.redirect(new URL(REDIRECT_SUCCESS, req.url));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('[Alipay Return] unexpected error:', errorMessage, errorStack);
    return NextResponse.redirect(new URL(REDIRECT_ERROR, req.url));
  }
};
