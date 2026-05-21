import type { CreditLedgerEntryItem, UserCreditAccountItem } from '@/database/schemas/credit';
import { type CreditProduct } from '@/business/server/credits/products';
import { lambdaClient } from '@/libs/trpc/client/lambda';

/**
 * Client-side service for Subscription and Credit operations
 *
 * This service provides a clean interface for frontend components
 * to interact with subscription and credit data using tRPC client.
 */
class SubscriptionService {
  // Credit operations
  async getCreditProducts(): Promise<readonly CreditProduct[]> {
    return await lambdaClient.subscription.creditProducts.query();
  }

  async getMyCreditAccount(): Promise<UserCreditAccountItem> {
    return await lambdaClient.subscription.myCreditAccount.query();
  }

  async listLedgerEntries(limit = 20): Promise<CreditLedgerEntryItem[]> {
    return await lambdaClient.subscription.listLedgerEntries.query({ limit });
  }

  async createCreditRechargeOrder(
    productId: string,
  ): Promise<{ orderId: string; paymentUrl: string }> {
    return await lambdaClient.subscription.createCreditRechargeOrder.mutate({ productId });
  }
}

export const subscriptionService = new SubscriptionService();
