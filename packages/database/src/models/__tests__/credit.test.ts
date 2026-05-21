// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { creditLedgerEntries, paymentOrders, userCreditAccounts, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { CreditModel } from '../credit';

const userId = 'user-credit-test';
const otherUserId = 'user-credit-test-2';
const testUserIds = [userId, otherUserId];

const serverDB: LobeChatDatabase = await getTestDB();
const creditModel = new CreditModel(serverDB, userId);
const otherCreditModel = new CreditModel(serverDB, otherUserId);

const seedUsers = async () => {
  await serverDB.insert(users).values(testUserIds.map((id) => ({ id }))).onConflictDoNothing();
};

const cleanupUsers = async () => {
  await serverDB.execute(
    sql`DELETE FROM ${creditLedgerEntries} WHERE ${creditLedgerEntries.userId} IN (${sql.join(
      testUserIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  await serverDB.execute(
    sql`DELETE FROM ${paymentOrders} WHERE ${paymentOrders.userId} IN (${sql.join(
      testUserIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  await serverDB.execute(
    sql`DELETE FROM ${userCreditAccounts} WHERE ${userCreditAccounts.userId} IN (${sql.join(
      testUserIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  await serverDB.execute(
    sql`DELETE FROM ${users} WHERE ${users.id} IN (${sql.join(
      testUserIds.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
};

beforeEach(async () => {
  await cleanupUsers();
  await seedUsers();
});

afterEach(async () => {
  await cleanupUsers();
});

describe('CreditModel', () => {
  it('creates an account with zero balance when missing', async () => {
    const account = await creditModel.getOrCreateAccount();

    expect(account.userId).toBe(userId);
    expect(account.balance).toBe(0);
  });

  it('grants recharge credits once per payment order source', async () => {
    await creditModel.grantRecharge({
      credits: 1000,
      metadata: { productId: 'credits_1000' },
      orderId: 'order-1',
    });
    await creditModel.grantRecharge({
      credits: 1000,
      metadata: { productId: 'credits_1000' },
      orderId: 'order-1',
    });

    const account = await creditModel.getOrCreateAccount();
    const entries = await creditModel.listLedgerEntries(10);

    expect(account.balance).toBe(1000);
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(1000);
    expect(entries[0].balanceAfter).toBe(1000);
    expect(entries[0].sourceId).toBe('order-1');
    expect(entries[0].sourceType).toBe('payment_order');
  });

  it('writes ledger entries once with final values instead of placeholder updates', async () => {
    const recharge = await creditModel.grantRecharge({
      credits: 45,
      metadata: { productId: 'credits_45' },
      orderId: 'order-final-values',
    });

    const usage = await creditModel.chargeUsage({
      credits: 12,
      metadata: { model: 'gpt-4.1' },
      sourceId: 'call-final-values',
    });

    expect(recharge.amount).toBe(45);
    expect(recharge.balanceAfter).toBe(45);
    expect(usage.entry.amount).toBe(-12);
    expect(usage.entry.balanceAfter).toBe(33);
  });

  it('does not double increment balance for duplicate recharge requests', async () => {
    const first = await creditModel.grantRecharge({
      credits: 125,
      metadata: { productId: 'credits_125' },
      orderId: 'order-no-double-increment',
    });
    const duplicate = await creditModel.grantRecharge({
      credits: 125,
      metadata: { productId: 'credits_125' },
      orderId: 'order-no-double-increment',
    });

    const account = await creditModel.getOrCreateAccount();
    const entries = await creditModel.listLedgerEntries(10);

    expect(duplicate.id).toBe(first.id);
    expect(account.balance).toBe(125);
    expect(entries.filter((entry) => entry.sourceId === 'order-no-double-increment')).toHaveLength(1);
  });

  it('allows different users to reuse the same source id independently', async () => {
    await creditModel.grantRecharge({
      credits: 100,
      metadata: { productId: 'credits_100' },
      orderId: 'shared-order-id',
    });
    await otherCreditModel.grantRecharge({
      credits: 60,
      metadata: { productId: 'credits_60' },
      orderId: 'shared-order-id',
    });

    const account = await creditModel.getOrCreateAccount();
    const otherAccount = await otherCreditModel.getOrCreateAccount();
    const entries = await creditModel.listLedgerEntries(10);
    const otherEntries = await otherCreditModel.listLedgerEntries(10);

    expect(account.balance).toBe(100);
    expect(otherAccount.balance).toBe(60);
    expect(entries).toHaveLength(1);
    expect(otherEntries).toHaveLength(1);
    expect(entries[0].userId).toBe(userId);
    expect(otherEntries[0].userId).toBe(otherUserId);
    expect(entries[0].sourceId).toBe('shared-order-id');
    expect(otherEntries[0].sourceId).toBe('shared-order-id');
  });

  it('clamps usage deduction to the remaining balance', async () => {
    await creditModel.grantRecharge({
      credits: 50,
      metadata: {},
      orderId: 'order-2',
    });

    const result = await creditModel.chargeUsage({
      credits: 80,
      metadata: { model: 'gpt-4.1' },
      sourceId: 'call-1',
    });

    const account = await creditModel.getOrCreateAccount();
    const entries = await creditModel.listLedgerEntries(10);

    expect(result.chargedCredits).toBe(50);
    expect(result.entry.amount).toBe(-50);
    expect(account.balance).toBe(0);
    expect(entries[0].sourceId).toBe('call-1');
    expect(entries[0].balanceAfter).toBe(0);
  });

  it('returns the newest ledger entries first with a stable tiebreaker', async () => {
    const [firstEntry, secondEntry] = await Promise.all([
      creditModel.grantRecharge({
        credits: 40,
        metadata: { productId: 'credits_40' },
        orderId: 'order-3',
      }),
      creditModel.chargeUsage({
        credits: 0,
        metadata: { model: 'gpt-4.1' },
        sourceId: 'call-2',
      }).then(({ entry }) => entry),
    ]);

    await serverDB
      .update(creditLedgerEntries)
      .set({ createdAt: firstEntry.createdAt })
      .where(eq(creditLedgerEntries.id, secondEntry.id));

    const entries = await creditModel.listLedgerEntries(10);
    const repeatedEntries = await creditModel.listLedgerEntries(10);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id).sort()).toEqual([firstEntry.id, secondEntry.id].sort());
    expect(repeatedEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });

  it('allows recharge and usage entries to share a source id without breaking idempotency', async () => {
    const recharge = await creditModel.grantRecharge({
      credits: 75,
      metadata: { productId: 'credits_75' },
      orderId: 'shared-source-id',
    });

    const firstCharge = await creditModel.chargeUsage({
      credits: 20,
      metadata: { model: 'gpt-4.1' },
      sourceId: 'shared-source-id',
    });
    const secondCharge = await creditModel.chargeUsage({
      credits: 20,
      metadata: { model: 'gpt-4.1' },
      sourceId: 'shared-source-id',
    });
    const duplicateRecharge = await creditModel.grantRecharge({
      credits: 75,
      metadata: { productId: 'credits_75' },
      orderId: 'shared-source-id',
    });

    const account = await creditModel.getOrCreateAccount();
    const entries = await creditModel.listLedgerEntries(10);

    expect(firstCharge.chargedCredits).toBe(20);
    expect(secondCharge.chargedCredits).toBe(20);
    expect(secondCharge.entry.id).toBe(firstCharge.entry.id);
    expect(duplicateRecharge.id).toBe(recharge.id);
    expect(account.balance).toBe(55);
    expect(entries.filter((entry) => entry.sourceId === 'shared-source-id')).toHaveLength(2);
    expect(entries.filter((entry) => entry.type === 'recharge')).toHaveLength(1);
    expect(entries.filter((entry) => entry.type === 'usage')).toHaveLength(1);
  });

  it('returns the existing entry for duplicate usage requests', async () => {
    await creditModel.grantRecharge({
      credits: 30,
      metadata: { productId: 'credits_30' },
      orderId: 'order-duplicate-usage',
    });

    const firstCharge = await creditModel.chargeUsage({
      credits: 12,
      metadata: { model: 'gpt-4.1' },
      sourceId: 'duplicate-call-id',
    });
    const duplicateCharge = await creditModel.chargeUsage({
      credits: 99,
      metadata: { model: 'gpt-4.1' },
      sourceId: 'duplicate-call-id',
    });

    const account = await creditModel.getOrCreateAccount();

    expect(duplicateCharge.entry.id).toBe(firstCharge.entry.id);
    expect(duplicateCharge.chargedCredits).toBe(12);
    expect(account.balance).toBe(18);
  });

  describe('payment orders', () => {
    it('creates a pending payment order', async () => {
      const order = await creditModel.createPaymentOrder(userId, 'credits_100', {
        outTradeNo: 'TEST_ORDER_001',
        provider: 'alipay',
        amountCents: 999,
        credits: 100,
      });

      expect(order).toBeDefined();
      expect(order!.status).toBe('pending');
      expect(order!.outTradeNo).toBe('TEST_ORDER_001');
      expect(order!.amountCents).toBe(999);
      expect(order!.credits).toBe(100);
      expect(order!.userId).toBe(userId);
    });

    it('finds a payment order by out_trade_no', async () => {
      await creditModel.createPaymentOrder(userId, 'credits_200', {
        outTradeNo: 'TEST_ORDER_002',
        provider: 'alipay',
        amountCents: 1999,
        credits: 200,
      });

      const found = await creditModel.findPaymentOrderByOutTradeNo('TEST_ORDER_002');
      expect(found).toBeDefined();
      expect(found!.outTradeNo).toBe('TEST_ORDER_002');
    });

    it('returns undefined when order is not found', async () => {
      const found = await creditModel.findPaymentOrderByOutTradeNo('NON_EXISTENT');
      expect(found).toBeUndefined();
    });

    it('marks an order as paid and grants credits', async () => {
      const order = await creditModel.createPaymentOrder(userId, 'credits_500', {
        outTradeNo: 'TEST_ORDER_003',
        provider: 'alipay',
        amountCents: 4999,
        credits: 500,
      });

      const updated = await creditModel.markOrderPaid({
        outTradeNo: 'TEST_ORDER_003',
        providerTradeNo: 'ALIPAY_123',
        rawNotify: { trade_status: 'TRADE_SUCCESS' },
      });

      expect(updated.status).toBe('paid');
      expect(updated.providerTradeNo).toBe('ALIPAY_123');

      const account = await creditModel.getOrCreateAccount();
      expect(account.balance).toBe(500);

      const entries = await creditModel.listLedgerEntries(10);
      expect(entries).toHaveLength(1);
      expect(entries[0].amount).toBe(500);
      expect(entries[0].sourceType).toBe('payment_order');
      expect(entries[0].sourceId).toBe(order!.id);
    });

    it('is idempotent when marking an already paid order', async () => {
      await creditModel.createPaymentOrder(userId, 'credits_100', {
        outTradeNo: 'TEST_ORDER_004',
        provider: 'alipay',
        amountCents: 999,
        credits: 100,
      });

      const first = await creditModel.markOrderPaid({
        outTradeNo: 'TEST_ORDER_004',
        rawNotify: { trade_status: 'TRADE_SUCCESS' },
      });
      const second = await creditModel.markOrderPaid({
        outTradeNo: 'TEST_ORDER_004',
        rawNotify: { trade_status: 'TRADE_SUCCESS' },
      });

      expect(second.id).toBe(first.id);

      const account = await creditModel.getOrCreateAccount();
      expect(account.balance).toBe(100);

      const entries = await creditModel.listLedgerEntries(10);
      expect(entries).toHaveLength(1);
    });

    it('throws when marking an order paid for a different provider', async () => {
      await creditModel.createPaymentOrder(userId, 'credits_100', {
        outTradeNo: 'TEST_ORDER_PROVIDER_MISMATCH',
        provider: 'alipay',
        amountCents: 999,
        credits: 100,
      });

      await expect(
        creditModel.markOrderPaid({
          outTradeNo: 'TEST_ORDER_PROVIDER_MISMATCH',
          provider: 'stripe',
          rawNotify: { trade_status: 'TRADE_SUCCESS' },
        }),
      ).rejects.toThrow('Payment order provider mismatch');
    });

    it('throws when marking a non-existent order as paid', async () => {
      await expect(
        creditModel.markOrderPaid({
          outTradeNo: 'NON_EXISTENT',
          rawNotify: { trade_status: 'TRADE_SUCCESS' },
        }),
      ).rejects.toThrow('Payment order not found');
    });
  });
});
