import { and, desc, eq, sql } from 'drizzle-orm';

import {
  creditLedgerEntries,
  type CreditLedgerEntryItem,
  paymentOrders,
  type NewPaymentOrder,
  type PaymentOrderItem,
  userCreditAccounts,
  type UserCreditAccountItem,
} from '../schemas';
import type { LobeChatDatabase, Transaction } from '../type';
import { idGenerator } from '../utils/idGenerator';

interface GrantRechargeParams {
  credits: number;
  metadata: Record<string, unknown>;
  orderId: string;
}

interface ChargeUsageParams {
  credits: number;
  metadata: Record<string, unknown>;
  sourceId: string;
}

type DBExecutor = LobeChatDatabase | Transaction;

interface CreditAccountBalanceRow {
  balance: number;
}

export class CreditModel {
  private userId: string;
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string) {
    this.userId = userId;
    this.db = db;
  }

  private findExistingLedgerEntry = async (
    executor: DBExecutor,
    type: 'recharge' | 'usage',
    sourceType: 'payment_order' | 'model_call',
    sourceId: string,
  ) => {
    return executor.query.creditLedgerEntries.findFirst({
      where: and(
        eq(creditLedgerEntries.userId, this.userId),
        eq(creditLedgerEntries.type, type),
        eq(creditLedgerEntries.sourceType, sourceType),
        eq(creditLedgerEntries.sourceId, sourceId),
      ),
    });
  };

  private insertLedgerEntry = async (
    executor: DBExecutor,
    params: {
      amount: number;
      balanceAfter: number;
      metadata: Record<string, unknown>;
      sourceId: string;
      sourceType: 'payment_order' | 'model_call';
      type: 'recharge' | 'usage';
    },
  ) => {
    const [entry] = await executor
      .insert(creditLedgerEntries)
      .values({
        amount: params.amount,
        balanceAfter: params.balanceAfter,
        id: idGenerator('budget'),
        metadata: params.metadata,
        sourceId: params.sourceId,
        sourceType: params.sourceType,
        type: params.type,
        userId: this.userId,
      })
      .onConflictDoNothing({
        target: [
          creditLedgerEntries.userId,
          creditLedgerEntries.type,
          creditLedgerEntries.sourceType,
          creditLedgerEntries.sourceId,
        ],
      })
      .returning();

    return entry ?? null;
  };

  private lockIdempotencyKey = async (
    executor: DBExecutor,
    type: 'recharge' | 'usage',
    sourceType: 'payment_order' | 'model_call',
    sourceId: string,
  ) => {
    await executor.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`${this.userId}:${type}:${sourceType}:${sourceId}`}))
    `);
  };

  private incrementBalance = async (executor: DBExecutor, credits: number): Promise<number> => {
    const [account] = await executor
      .insert(userCreditAccounts)
      .values({ balance: credits, userId: this.userId })
      .onConflictDoUpdate({
        set: {
          balance: sql`${userCreditAccounts.balance} + ${credits}`,
          updatedAt: new Date(),
        },
        target: userCreditAccounts.userId,
      })
      .returning({ balance: userCreditAccounts.balance });

    return account?.balance ?? credits;
  };

  private lockAccountBalance = async (executor: DBExecutor): Promise<number> => {
    await this.getOrCreateAccount(executor);

    const result = await executor.execute(sql`
      SELECT ${userCreditAccounts.balance}
      FROM ${userCreditAccounts}
      WHERE ${userCreditAccounts.userId} = ${this.userId}
      FOR UPDATE
    `);

    return Number((result.rows[0] as unknown as CreditAccountBalanceRow | undefined)?.balance ?? 0);
  };

  private deductBalance = async (
    executor: DBExecutor,
    currentBalance: number,
    requestedCredits: number,
  ) => {
    const chargedCredits = Math.min(currentBalance, requestedCredits);
    const balanceAfter = currentBalance - chargedCredits;

    await executor
      .update(userCreditAccounts)
      .set({ balance: balanceAfter, updatedAt: new Date() })
      .where(eq(userCreditAccounts.userId, this.userId));

    return { balanceAfter, chargedCredits };
  };

  getOrCreateAccount = async (executor: DBExecutor = this.db): Promise<UserCreditAccountItem> => {
    const [account] = await executor
      .insert(userCreditAccounts)
      .values({ userId: this.userId })
      .onConflictDoNothing()
      .returning();

    if (account) return account;

    const existing = await executor.query.userCreditAccounts.findFirst({
      where: eq(userCreditAccounts.userId, this.userId),
    });

    if (!existing) throw new Error('Failed to create credit account');

    return existing;
  };

  private _grantRecharge = async (
    executor: DBExecutor,
    { credits, metadata, orderId }: GrantRechargeParams,
  ) => {
    await this.lockIdempotencyKey(executor, 'recharge', 'payment_order', orderId);

    const existing = await this.findExistingLedgerEntry(executor, 'recharge', 'payment_order', orderId);

    if (existing) return existing;

    const balanceAfter = await this.incrementBalance(executor, credits);
    const inserted = await this.insertLedgerEntry(executor, {
      amount: credits,
      balanceAfter,
      metadata,
      sourceId: orderId,
      sourceType: 'payment_order',
      type: 'recharge',
    });

    if (inserted) return inserted;

    const duplicated = await this.findExistingLedgerEntry(executor, 'recharge', 'payment_order', orderId);

    if (!duplicated) throw new Error('Failed to load recharge ledger entry after conflict');

    return duplicated;
  };

  grantRecharge = async (params: GrantRechargeParams) => {
    return this.db.transaction(async (tx) => this._grantRecharge(tx, params));
  };

  createPaymentOrder = async (
    userId: string,
    productId: string,
    metadata: {
      outTradeNo: string;
      provider: 'alipay';
      amountCents: number;
      credits: number;
      [key: string]: unknown;
    },
  ) => {
    const [order] = await this.db
      .insert(paymentOrders)
      .values({
        id: idGenerator('budget'),
        userId,
        productId,
        outTradeNo: metadata.outTradeNo,
        provider: metadata.provider,
        amountCents: metadata.amountCents,
        credits: metadata.credits,
        status: 'pending',
      })
      .returning();

    return order;
  };

  findPaymentOrderByOutTradeNo = async (outTradeNo: string): Promise<PaymentOrderItem | undefined> => {
    return this.db.query.paymentOrders.findFirst({
      where: eq(paymentOrders.outTradeNo, outTradeNo),
    });
  };

  markOrderPaid = async (params: {
    outTradeNo: string;
    provider?: string;
    providerTradeNo?: string;
    rawNotify: Record<string, unknown>;
  }) => {
    return this.db.transaction(async (tx) => {
      // Use FOR UPDATE to prevent race condition with concurrent webhooks
      const result = await tx.execute(sql`
        SELECT * FROM ${paymentOrders}
        WHERE ${paymentOrders.outTradeNo} = ${params.outTradeNo}
        FOR UPDATE
      `);

      if (!result.rows.length) throw new Error('Payment order not found');
      const order = result.rows[0] as unknown as PaymentOrderItem;

      if (params.provider && order.provider !== params.provider) {
        throw new Error('Payment order provider mismatch');
      }

      if (order.status === 'paid') return order;

      const [updated] = await tx
        .update(paymentOrders)
        .set({
          status: 'paid',
          paidAt: new Date(),
          providerTradeNo: params.providerTradeNo,
          rawNotify: params.rawNotify,
          updatedAt: new Date(),
        })
        .where(eq(paymentOrders.id, order.id))
        .returning();

      await this._grantRecharge(tx, {
        credits: order.credits,
        metadata: { productId: order.productId, amountCents: order.amountCents, ...params.rawNotify },
        orderId: order.id,
      });

      return updated;
    });
  };

  chargeUsage = async ({ credits, metadata, sourceId }: ChargeUsageParams) => {
    return this.db.transaction(async (tx) => {
      await this.lockIdempotencyKey(tx, 'usage', 'model_call', sourceId);

      const existing = await this.findExistingLedgerEntry(tx, 'usage', 'model_call', sourceId);

      if (existing) {
        return { chargedCredits: Math.abs(existing.amount), entry: existing };
      }

      const currentBalance = await this.lockAccountBalance(tx);
      const { balanceAfter, chargedCredits } = await this.deductBalance(tx, currentBalance, credits);
      const inserted = await this.insertLedgerEntry(tx, {
        amount: -chargedCredits,
        balanceAfter,
        metadata,
        sourceId,
        sourceType: 'model_call',
        type: 'usage',
      });

      if (inserted) {
        return { chargedCredits, entry: inserted };
      }

      const duplicated = await this.findExistingLedgerEntry(tx, 'usage', 'model_call', sourceId);

      if (!duplicated) throw new Error('Failed to load usage ledger entry after conflict');

      return { chargedCredits: Math.abs(duplicated.amount), entry: duplicated };
    });
  };

  listLedgerEntries = async (limit = 20): Promise<CreditLedgerEntryItem[]> => {
    return this.db.query.creditLedgerEntries.findMany({
      limit,
      orderBy: [desc(creditLedgerEntries.createdAt), desc(creditLedgerEntries.id)],
      where: eq(creditLedgerEntries.userId, this.userId),
    });
  };
}
