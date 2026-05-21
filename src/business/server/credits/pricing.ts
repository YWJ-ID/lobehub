export interface CreditsPricingOptions {
  exchangeRateUsdToCny: number;
  marginMultiplier: number;
}

interface PricingDefinitionBase<TUnit extends string, TUsage extends object> {
  kind: TUnit;
  resolveCostUsd: (usage: TUsage) => number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CharactersUsage {
  characters?: number;
}

export interface MinutesUsage {
  minutes?: number;
}

export interface ImagesUsage {
  images?: number;
}

export interface VideoSecondsUsage {
  videoSeconds?: number;
}

export interface RequestsUsage {
  requests?: number;
}

export interface TokenPricing extends PricingDefinitionBase<'tokens', TokenUsage> {
  inputCostUsdPerMillionTokens?: number;
  outputCostUsdPerMillionTokens?: number;
}

export type TokenPricingConfig =
  | {
      inputCostUsdPerMillionTokens: number;
      outputCostUsdPerMillionTokens?: number;
    }
  | {
      inputCostUsdPerMillionTokens?: number;
      outputCostUsdPerMillionTokens: number;
    };

export interface CharactersPricing
  extends PricingDefinitionBase<'characters', CharactersUsage> {
  costUsdPerThousandCharacters: number;
}

export interface MinutesPricing extends PricingDefinitionBase<'minutes', MinutesUsage> {
  costUsdPerMinute: number;
}

export interface ImagesPricing extends PricingDefinitionBase<'images', ImagesUsage> {
  costUsdPerImage: number;
}

export interface VideoSecondsPricing
  extends PricingDefinitionBase<'video_seconds', VideoSecondsUsage> {
  costUsdPerVideoSecond: number;
}

export interface RequestsPricing extends PricingDefinitionBase<'requests', RequestsUsage> {
  costUsdPerRequest: number;
}

export type ModelPricing =
  | CharactersPricing
  | ImagesPricing
  | MinutesPricing
  | RequestsPricing
  | TokenPricing
  | VideoSecondsPricing;

export type ModelUsage =
  | CharactersUsage
  | ImagesUsage
  | MinutesUsage
  | RequestsUsage
  | TokenUsage
  | VideoSecondsUsage;

export const createTokenPricing = ({
  inputCostUsdPerMillionTokens,
  outputCostUsdPerMillionTokens,
}: TokenPricingConfig): TokenPricing => {
  if (
    inputCostUsdPerMillionTokens === undefined &&
    outputCostUsdPerMillionTokens === undefined
  ) {
    throw new Error('createTokenPricing requires at least one token cost rate.');
  }

  return {
    inputCostUsdPerMillionTokens,
    kind: 'tokens',
    outputCostUsdPerMillionTokens,
    resolveCostUsd: ({ inputTokens = 0, outputTokens = 0 }) =>
      inputTokens * (inputCostUsdPerMillionTokens ?? 0) / 1_000_000 +
      outputTokens * (outputCostUsdPerMillionTokens ?? 0) / 1_000_000,
  };
};

export const createCharactersPricing = ({
  costUsdPerThousandCharacters,
}: {
  costUsdPerThousandCharacters: number;
}): CharactersPricing => ({
  costUsdPerThousandCharacters,
  kind: 'characters',
  resolveCostUsd: ({ characters = 0 }) => characters * costUsdPerThousandCharacters / 1000,
});

export const createMinutesPricing = ({
  costUsdPerMinute,
}: {
  costUsdPerMinute: number;
}): MinutesPricing => ({
  costUsdPerMinute,
  kind: 'minutes',
  resolveCostUsd: ({ minutes = 0 }) => minutes * costUsdPerMinute,
});

export const createImagePricing = ({
  costUsdPerImage,
}: {
  costUsdPerImage: number;
}): ImagesPricing => ({
  costUsdPerImage,
  kind: 'images',
  resolveCostUsd: ({ images = 0 }) => images * costUsdPerImage,
});

export const createVideoSecondsPricing = ({
  costUsdPerVideoSecond,
}: {
  costUsdPerVideoSecond: number;
}): VideoSecondsPricing => ({
  costUsdPerVideoSecond,
  kind: 'video_seconds',
  resolveCostUsd: ({ videoSeconds = 0 }) => videoSeconds * costUsdPerVideoSecond,
});

export const createRequestsPricing = ({
  costUsdPerRequest,
}: {
  costUsdPerRequest: number;
}): RequestsPricing => ({
  costUsdPerRequest,
  kind: 'requests',
  resolveCostUsd: ({ requests = 0 }) => requests * costUsdPerRequest,
});

export const calculateCreditsFromCost = (
  rawCostUsd: number,
  { exchangeRateUsdToCny, marginMultiplier }: CreditsPricingOptions,
): number => {
  if (rawCostUsd <= 0) return 0;

  const credits = rawCostUsd * exchangeRateUsdToCny * marginMultiplier * 100;

  return Math.max(1, Math.ceil(credits));
};

export const calculateCreditsCharge = <TPricing extends ModelPricing>({
  pricing,
  usage,
}: {
  pricing: TPricing;
  usage: TPricing extends PricingDefinitionBase<string, infer TUsage> ? TUsage : never;
}, options: CreditsPricingOptions): number =>
  calculateCreditsFromCost(pricing.resolveCostUsd(usage), options);
