import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { CreditModel } from '@/database/models/credit';
import { CREDIT_PRODUCTS, getCreditProduct } from '@/business/server/credits/products';
import { buildPagePayUrl } from '@/business/server/alipay/client';
import { idGenerator } from '@/database/utils/idGenerator';
import { authedProcedure, publicProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

const creditProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;

  const creditModel = new CreditModel(ctx.serverDB, ctx.userId);

  return opts.next({
    ctx: { creditModel },
  });
});

export const subscriptionRouter = router({
  creditProducts: publicProcedure.query(() => {
    return CREDIT_PRODUCTS;
  }),

  myCreditAccount: creditProcedure.query(async ({ ctx }) => {
    const account = await ctx.creditModel.getOrCreateAccount();
    return account;
  }),

  listLedgerEntries: creditProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).optional().default(20),
      }),
    )
    .query(async ({ input, ctx }) => {
      return ctx.creditModel.listLedgerEntries(input.limit);
    }),

  createCreditRechargeOrder: creditProcedure
    .input(
      z.object({
        productId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const product = getCreditProduct(input.productId);

      if (!product) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Invalid product ID: ${input.productId}`,
        });
      }

      const outTradeNo = idGenerator('budget');
      const order = await ctx.creditModel.createPaymentOrder(ctx.userId, input.productId, {
        outTradeNo,
        provider: 'alipay',
        amountCents: Math.round(product.priceCny * 100),
        credits: product.credits,
      });

      try {
        const paymentUrl = buildPagePayUrl({
          out_trade_no: outTradeNo,
          total_amount: (product.priceCny).toFixed(2),
          subject: `充值 ${product.credits} 积分`,
          body: `充值 ${product.credits} 积分`,
          product_code: 'FAST_INSTANT_TRADE_PAY',
          return_url: `${process.env.NEXTAUTH_URL || 'https://app.lobehub.com'}/api/webhooks/alipay/return`,
          notify_url: `${process.env.NEXTAUTH_URL || 'https://app.lobehub.com'}/api/webhooks/alipay/notify`,
        });

        return { orderId: order.id, paymentUrl };
      } catch (error) {
        console.error('[createCreditRechargeOrder] Failed to build payment URL:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create payment URL',
        });
      }
    }),
});
