export const CREDIT_PRODUCT_IDS = ['credits_1000', 'credits_5000', 'credits_10000'] as const;

export type CreditProductId = (typeof CREDIT_PRODUCT_IDS)[number];

export interface CreditProduct {
  readonly credits: number;
  readonly id: CreditProductId;
  readonly priceCny: number;
}

const freezeCreditProduct = <T extends CreditProduct>(product: T): Readonly<T> =>
  Object.freeze(product);

export const CREDIT_PRODUCTS = Object.freeze([
  freezeCreditProduct({
    credits: 1000,
    id: 'credits_1000',
    priceCny: 10,
  }),
  freezeCreditProduct({
    credits: 5000,
    id: 'credits_5000',
    priceCny: 50,
  }),
  freezeCreditProduct({
    credits: 10000,
    id: 'credits_10000',
    priceCny: 100,
  }),
] as const satisfies readonly CreditProduct[]);

const CREDIT_PRODUCT_MAP: Readonly<Record<CreditProductId, (typeof CREDIT_PRODUCTS)[number]>> =
  Object.freeze({
    credits_1000: CREDIT_PRODUCTS[0],
    credits_5000: CREDIT_PRODUCTS[1],
    credits_10000: CREDIT_PRODUCTS[2],
  });

export const isCreditProductId = (value: string): value is CreditProductId =>
  value in CREDIT_PRODUCT_MAP;

export const getCreditProduct = (
  productId: string,
): (typeof CREDIT_PRODUCTS)[number] | undefined => {
  if (!isCreditProductId(productId)) return undefined;

  return CREDIT_PRODUCT_MAP[productId];
};

export const getCreditPricingOptions = () => {
  return {
    exchangeRateUsdToCny: 7.2,
    marginMultiplier: 1.2,
  };
};
