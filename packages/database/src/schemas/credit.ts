import { relations } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, timestamptz, updatedAt } from './_helpers';
import { users } from './user';

export const paymentOrders = pgTable(
  'payment_orders',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    provider: text('provider').$type<'alipay'>().notNull(),
    outTradeNo: text('out_trade_no').notNull(),
    providerTradeNo: text('provider_trade_no'),
    productId: text('product_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    credits: integer('credits').notNull(),
    status: text('status').$type<'pending' | 'paid' | 'closed' | 'failed' | 'refunded'>().default('pending').notNull(),
    paidAt: timestamptz('paid_at'),
    rawNotify: jsonb('raw_notify').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('payment_orders_out_trade_no_idx').on(table.outTradeNo)],
);

export const userCreditAccounts = pgTable('user_credit_accounts', {
  userId: text('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .primaryKey()
    .notNull(),
  balance: integer('balance').default(0).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const creditLedgerEntries = pgTable(
  'credit_ledger_entries',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    type: text('type').$type<'recharge' | 'usage' | 'adjustment'>().notNull(),
    amount: integer('amount').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('credit_ledger_user_id_created_at_idx').on(table.userId, table.createdAt, table.id),
    uniqueIndex('credit_ledger_user_type_source_idx').on(
      table.userId,
      table.type,
      table.sourceType,
      table.sourceId,
    ),
  ],
);

export const paymentOrderRelations = relations(paymentOrders, ({ one }) => ({
  user: one(users, { fields: [paymentOrders.userId], references: [users.id] }),
}));

export const userCreditAccountRelations = relations(userCreditAccounts, ({ one }) => ({
  user: one(users, { fields: [userCreditAccounts.userId], references: [users.id] }),
}));

export const creditLedgerEntryRelations = relations(creditLedgerEntries, ({ one }) => ({
  user: one(users, { fields: [creditLedgerEntries.userId], references: [users.id] }),
}));

export type NewPaymentOrder = typeof paymentOrders.$inferInsert;
export type PaymentOrderItem = typeof paymentOrders.$inferSelect;
export type NewUserCreditAccount = typeof userCreditAccounts.$inferInsert;
export type UserCreditAccountItem = typeof userCreditAccounts.$inferSelect;
export type NewCreditLedgerEntry = typeof creditLedgerEntries.$inferInsert;
export type CreditLedgerEntryItem = typeof creditLedgerEntries.$inferSelect;
