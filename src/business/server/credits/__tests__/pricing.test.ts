import type { CreditProduct } from '@/business/server/credits/products';
import {
  CREDIT_PRODUCTS,
  getCreditProduct,
  isCreditProductId,
} from '@/business/server/credits/products';
import {
  calculateCreditsCharge,
  calculateCreditsFromCost,
  createCharactersPricing,
  createImagePricing,
  createMinutesPricing,
  createRequestsPricing,
  createTokenPricing,
  createVideoSecondsPricing,
} from '@/business/server/credits/pricing';

describe('credit products', () => {
  it('defines the fixed prepaid recharge packages', () => {
    expect(CREDIT_PRODUCTS).toEqual([
      {
        credits: 1000,
        id: 'credits_1000',
        priceCny: 10,
      },
      {
        credits: 5000,
        id: 'credits_5000',
        priceCny: 50,
      },
      {
        credits: 10000,
        id: 'credits_10000',
        priceCny: 100,
      },
    ]);
  });

  it('looks up products by id', () => {
    expect(getCreditProduct('credits_5000')).toEqual({
      credits: 5000,
      id: 'credits_5000',
      priceCny: 50,
    });
    expect(getCreditProduct('missing_product')).toBeUndefined();
  });

  it('checks whether a string is a known product id', () => {
    expect(isCreditProductId('credits_1000')).toBe(true);
    expect(isCreditProductId('credits_9999')).toBe(false);
  });

  it('exposes immutable product config to consumers', () => {
    expect(Object.isFrozen(CREDIT_PRODUCTS)).toBe(true);
    expect(Object.isFrozen(CREDIT_PRODUCTS[0])).toBe(true);

    expect(() => {
      (CREDIT_PRODUCTS as unknown as CreditProduct[]).push({
        credits: 20_000,
        id: 'credits_10000',
        priceCny: 200,
      });
    }).toThrow(TypeError);

    const product = getCreditProduct('credits_5000');

    expect(product).toBeDefined();
    expect(() => {
      (product as { priceCny: number }).priceCny = 999;
    }).toThrow(TypeError);
    expect(getCreditProduct('credits_5000')?.priceCny).toBe(50);
  });
});

describe('credit pricing calculator', () => {
  it('calculates token charges from separate input and output rates', () => {
    const pricing = createTokenPricing({
      inputCostUsdPerMillionTokens: 0.5,
      outputCostUsdPerMillionTokens: 1.5,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            inputTokens: 120_000,
            outputTokens: 80_000,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(395);
  });

  it('charges a minimum of one credit for positive token usage', () => {
    const pricing = createTokenPricing({
      inputCostUsdPerMillionTokens: 0.01,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            inputTokens: 1,
            outputTokens: 0,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(1);
  });

  it('returns zero for zero token usage', () => {
    const pricing = createTokenPricing({
      inputCostUsdPerMillionTokens: 0.5,
      outputCostUsdPerMillionTokens: 1.5,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(0);
  });

  it('throws when token pricing omits both token rates', () => {
    expect(() =>
      createTokenPricing({} as Parameters<typeof createTokenPricing>[0]),
    ).toThrow('createTokenPricing requires at least one token cost rate.');
  });

  it('defaults omitted token usage fields to zero', () => {
    const inputOnlyPricing = createTokenPricing({
      inputCostUsdPerMillionTokens: 0.5,
    });
    const outputOnlyPricing = createTokenPricing({
      outputCostUsdPerMillionTokens: 1.5,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing: inputOnlyPricing,
          usage: {},
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(0);
    expect(
      calculateCreditsCharge(
        {
          pricing: outputOnlyPricing,
          usage: {},
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(0);
  });

  it('calculates character-metered charges', () => {
    const pricing = createCharactersPricing({
      costUsdPerThousandCharacters: 0.015,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            characters: 2_500,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(83);
  });

  it('defaults omitted character usage fields to zero', () => {
    const pricing = createCharactersPricing({
      costUsdPerThousandCharacters: 0.015,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {},
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(0);
  });

  it('calculates minute-metered charges', () => {
    const pricing = createMinutesPricing({
      costUsdPerMinute: 0.006,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            minutes: 12,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(158);
  });

  it('calculates image-metered charges', () => {
    const pricing = createImagePricing({
      costUsdPerImage: 0.04,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            images: 3,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(263);
  });

  it('calculates video-second charges', () => {
    const pricing = createVideoSecondsPricing({
      costUsdPerVideoSecond: 0.2,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            videoSeconds: 8,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(3504);
  });

  it('falls back to request-based charges', () => {
    const pricing = createRequestsPricing({
      costUsdPerRequest: 0.03,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {
            requests: 2,
          },
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(132);
  });

  it('defaults omitted request usage fields to zero', () => {
    const pricing = createRequestsPricing({
      costUsdPerRequest: 0.03,
    });

    expect(
      calculateCreditsCharge(
        {
          pricing,
          usage: {},
        },
        {
          exchangeRateUsdToCny: 7.3,
          marginMultiplier: 3,
        },
      ),
    ).toBe(0);
  });

  it('enforces a one-credit minimum for positive direct costs', () => {
    expect(
      calculateCreditsFromCost(0.000001, {
        exchangeRateUsdToCny: 7.3,
        marginMultiplier: 3,
      }),
    ).toBe(1);
  });

  it('returns zero for zero direct cost', () => {
    expect(
      calculateCreditsFromCost(0, {
        exchangeRateUsdToCny: 7.3,
        marginMultiplier: 3,
      }),
    ).toBe(0);
  });
});
