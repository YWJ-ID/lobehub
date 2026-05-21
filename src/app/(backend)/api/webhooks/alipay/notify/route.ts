import { NextResponse } from 'next/server';

import { CreditModel } from '@/database/models/credit';
import { serverDB } from '@/database/server';
import { alipayEnv } from '@/envs/alipay';
import { getAlipayPublicKey, verifyNotifySignature } from '@/business/server/alipay/client';

const successResponse = () => new NextResponse('success', { status: 200 });

export const POST = async (req: Request): Promise<NextResponse> => {
  try {
    const body = await req.text();
    const searchParams = new URLSearchParams(body);
    const params: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      params[key] = value;
    });

    const signature = params.sign;
    const signType = params.sign_type;

    if (!signature) {
      console.warn('[Alipay Notify] missing signature');
      return successResponse();
    }

    if (signType && signType !== 'RSA2') {
      console.warn('[Alipay Notify] unsupported sign_type:', signType);
      return successResponse();
    }

    const publicKey = getAlipayPublicKey();
    if (!publicKey) {
      console.error('[Alipay Notify] ALIPAY_PUBLIC_KEY_PATH is not configured');
      return successResponse();
    }

    const { sign: _sign, sign_type: _signType, ...verifyParams } = params;
    const isValid = verifyNotifySignature(verifyParams, signature, publicKey);
    if (!isValid) {
      console.warn('[Alipay Notify] signature verification failed');
      return successResponse();
    }

    const appId = params.app_id;
    if (!appId || appId !== alipayEnv.ALIPAY_APP_ID) {
      console.warn('[Alipay Notify] app_id mismatch:', appId);
      return successResponse();
    }

    const sellerId = alipayEnv.ALIPAY_SELLER_ID;
    if (sellerId && params.seller_id !== sellerId) {
      console.warn('[Alipay Notify] seller_id mismatch:', params.seller_id);
      return successResponse();
    }

    const outTradeNo = params.out_trade_no;
    if (!outTradeNo) {
      console.warn('[Alipay Notify] missing out_trade_no');
      return successResponse();
    }

    const tradeNo = params.trade_no;
    if (!tradeNo) {
      console.warn('[Alipay Notify] missing trade_no');
      return successResponse();
    }

    const notifyId = params.notify_id;
    if (!notifyId) {
      console.warn('[Alipay Notify] missing notify_id');
      return successResponse();
    }

    const notifyTime = params.notify_time;
    if (!notifyTime) {
      console.warn('[Alipay Notify] missing notify_time');
      return successResponse();
    }

    const tradeStatus = params.trade_status;
    if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
      console.log('[Alipay Notify] ignored trade_status:', tradeStatus);
      return successResponse();
    }

    const totalAmount = params.total_amount;
    if (!totalAmount) {
      console.warn('[Alipay Notify] missing total_amount');
      return successResponse();
    }

    const order = await serverDB.query.paymentOrders.findFirst({
      where: (table, { eq }) => eq(table.outTradeNo, outTradeNo),
    });

    if (!order) {
      console.warn('[Alipay Notify] order not found:', outTradeNo);
      return successResponse();
    }

    if (order.provider !== 'alipay') {
      console.warn('[Alipay Notify] provider mismatch:', order.provider);
      return successResponse();
    }

    const expectedAmount = (order.amountCents / 100).toFixed(2);
    if (totalAmount !== expectedAmount) {
      console.warn('[Alipay Notify] total_amount mismatch:', totalAmount, 'expected:', expectedAmount);
      return successResponse();
    }

    if (order.status === 'paid') {
      return successResponse();
    }

    const creditModel = new CreditModel(serverDB, order.userId);
    await creditModel.markOrderPaid({
      outTradeNo,
      provider: 'alipay',
      providerTradeNo: tradeNo,
      rawNotify: params,
    });

    return successResponse();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error('[Alipay Notify] unexpected error:', errorMessage, errorStack);
    return successResponse();
  }
};
