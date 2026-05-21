import { getModelPricing } from '@lobechat/model-runtime';
import type { ModelUsage } from '@lobechat/types';
import type { Pricing } from 'model-bank';

import { calculateCreditsFromCost, createMinutesPricing, createRequestsPricing } from './pricing';
import { getCreditPricingOptions } from './products';

/**
 * Extended ModelUsage with additional billing fields
 * Extends @lobechat/types ModelUsage to include minutes, videoSeconds, images, and requests
 */
interface ExtendedModelUsage extends ModelUsage {
  characters?: number;
  images?: number;
  minutes?: number;
  requests?: number;
  videoSeconds?: number;
}

interface BillableUsageMetadata {
  characters?: number;
  images?: number;
  inputAudioTokens?: number;
  inputCachedAudioTokens?: number;
  inputCachedTokens?: number;
  inputCitationTokens?: number;
  inputImageTokens?: number;
  inputVideoTokens?: number;
  inputWriteCacheTokens?: number;
  minutes?: number;
  outputAudioTokens?: number;
  outputImageTokens?: number;
  requests?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  videoSeconds?: number;
}

interface CreditChargeParams {
  credits: number;
  metadata: Record<string, unknown>;
  sourceId: string;
}

/**
 * Billing service for calculating and charging credit usage
 * Bridges between model runtime and CreditModel
 */
export class BillingService {
  private readonly logPrefix = '[BillingService]';

  constructor(
    private chargeUsage: (params: CreditChargeParams) => Promise<{
      chargedCredits: number;
      entry: unknown;
    }>,
  ) {}

  /**
   * Calculate text charge from usage using pricing and charge credits
   */
  async calculateAndChargeTextUsage(params: {
    model: string;
    provider?: string;
    usage: ModelUsage;
    sourceId: string;
  }) {
    const { model, provider, usage, sourceId } = params;

    // Get pricing for this model
    const pricing = await getModelPricing(model, provider);

    if (!pricing) {
      console.warn(`[BillingService] No pricing found for model: ${model}, provider: ${provider}`);
      return { chargedCredits: 0 };
    }

    // Calculate credits to charge
    const credits = this.calculateChargeFromPricing(pricing, usage);

    if (credits <= 0) {
      return { chargedCredits: 0 };
    }

    const billableMetadata = this.buildBillableMetadata(pricing, usage, {
      chargedCredits: credits,
      model,
      provider,
    });

    // Charge credits
    const result = await this.chargeUsage({
      credits,
      metadata: billableMetadata,
      sourceId,
    });

    return { chargedCredits: result.chargedCredits };
  }

  private debug(message: string, details?: Record<string, unknown>) {
    console.debug(`${this.logPrefix} ${message}`, details ?? {});
  }

  private warn(message: string, details?: Record<string, unknown>) {
    console.warn(`${this.logPrefix} ${message}`, details ?? {});
  }

  private sanitizeBillableUsage(usage: ExtendedModelUsage): BillableUsageMetadata {
    const sanitizedUsage: BillableUsageMetadata = {
      characters: usage.characters,
      images: usage.images,
      inputAudioTokens: usage.inputAudioTokens,
      inputCachedAudioTokens: usage.inputCachedAudioTokens,
      inputCachedTokens: usage.inputCachedTokens,
      inputCitationTokens: usage.inputCitationTokens,
      inputImageTokens: usage.inputImageTokens,
      inputVideoTokens: usage.inputVideoTokens,
      inputWriteCacheTokens: usage.inputWriteCacheTokens,
      minutes: usage.minutes,
      outputAudioTokens: usage.outputAudioTokens,
      outputImageTokens: usage.outputImageTokens,
      requests: usage.requests,
      totalInputTokens: usage.totalInputTokens,
      totalOutputTokens: usage.totalOutputTokens,
      totalTokens: usage.totalTokens,
      videoSeconds: usage.videoSeconds,
    };

    return Object.fromEntries(
      Object.entries(sanitizedUsage).filter(([, value]) => typeof value === 'number' && value > 0),
    ) as BillableUsageMetadata;
  }

  private buildBillableMetadata(
    pricing: Pricing,
    usage: ExtendedModelUsage,
    details: { chargedCredits: number; model: string; provider?: string },
  ) {
    return {
      chargeBasis: pricing.units.map((unit) => `${unit.strategy}:${unit.name}:${unit.unit}`),
      chargedCredits: details.chargedCredits,
      model: details.model,
      provider: details.provider,
      unit: pricing.units.map((unit) => unit.unit),
      usage: this.sanitizeBillableUsage(usage),
    };
  }

  /**
   * Calculate credits charge from pricing and usage
   * Uses billing pricing calculator
   */
  private calculateChargeFromPricing(pricing: Pricing, usage: ExtendedModelUsage): number {
    const pricingOptions = getCreditPricingOptions();

    // Calculate total cost in USD from all pricing units
    let totalCostUsd = 0;

    for (const unit of pricing.units) {
      const unitCostUsd = this.calculateUnitCost(unit, usage);
      if (unitCostUsd > 0) {
        totalCostUsd += unitCostUsd;
      }
    }

    // Convert to credits using pricing options
    return calculateCreditsFromCost(totalCostUsd, pricingOptions);
  }

  /**
   * Calculate cost in USD for a specific pricing unit based on usage
   */
  private calculateUnitCost(unit: any, usage: ExtendedModelUsage): number {
    switch (unit.strategy) {
      case 'fixed': {
        return this.calculateFixedCost(unit, usage);
      }
      case 'tiered': {
        return this.calculateTieredCost(unit, usage);
      }
      case 'lookup': {
        return this.calculateLookupCost(unit, usage);
      }
      default: {
        return 0;
      }
    }
  }

  /**
   * Calculate fixed cost for a pricing unit
   */
  private calculateFixedCost(unit: any, usage: ExtendedModelUsage): number {
    const rate = unit.rate;
    const unitType = unit.unit;

    // Match usage to unit type
    switch (unitType) {
      case 'millionTokens': {
        const tokens = this.getTokensForUnit(unit.name, usage);
        return tokens * (rate / 1_000_000);
      }
      case 'millionCharacters': {
        const characters = this.getCharacterCount(unit.name, usage);
        return characters * (rate / 1_000_000);
      }
      case 'image': {
        const images = usage.images || 0;
        return images * rate;
      }
      case 'video': {
        const videos = this.getVideoCount(usage);
        return videos * rate;
      }
      case 'second': {
        // Handle both video seconds and regular seconds
        const seconds = usage.videoSeconds || 0;
        return seconds * rate;
      }
      case 'megapixel': {
        return 0; // Not tracked in current usage
      }
      default: {
        // Handle additional unit types using pricing calculators
        if (unitType === 'minute' && usage.minutes) {
          const pricing = createMinutesPricing({ costUsdPerMinute: rate });
          return pricing.resolveCostUsd({ minutes: usage.minutes });
        }
        if (unitType === 'request' && usage.requests) {
          const pricing = createRequestsPricing({ costUsdPerRequest: rate });
          return pricing.resolveCostUsd({ requests: usage.requests });
        }
        return 0;
      }
    }
  }

  /**
   * Get video count from usage
   * Derives from video seconds and video tokens
   */
  private getVideoCount(usage: ExtendedModelUsage): number {
    // If videoSeconds is provided, estimate videos (assuming 1 video per call)
    if (usage.videoSeconds && usage.videoSeconds > 0) {
      return 1;
    }
    // Otherwise check for video tokens as a fallback
    if (usage.inputVideoTokens) {
      return 1;
    }
    return 0;
  }

  /**
   * Calculate tiered cost for a pricing unit
   */
  private calculateTieredCost(unit: any, usage: ExtendedModelUsage): number {
    const tiers = unit.tiers;
    const unitType = unit.unit;

    // Get usage quantity for this unit
    const quantity = this.getQuantityForUnitType(unitType, unit.name, usage);

    let cost = 0;
    let remaining = quantity;

    for (const tier of tiers) {
      if (remaining <= 0) break;

      const tierSize = tier.upTo === 'infinity' ? remaining : Math.min(tier.upTo, remaining);
      cost += tierSize * tier.rate;
      remaining -= tierSize;
    }

    return cost;
  }

  /**
   * Calculate lookup cost for a pricing unit
   */
  private calculateLookupCost(unit: any, usage: ExtendedModelUsage): number {
    const quantity = this.getLookupQuantity(unit, usage);

    if (quantity <= 0) {
      this.warn('Skipping unsupported lookup pricing unit', {
        pricingParams: unit.lookup?.pricingParams,
        unit: unit.name,
      });
      return 0;
    }

    const lookupPrice = this.resolveLookupPrice(unit, usage);
    if (lookupPrice <= 0) {
      this.warn('Skipping lookup pricing without resolvable price', {
        pricingParams: unit.lookup?.pricingParams,
        unit: unit.name,
      });
      return 0;
    }

    return lookupPrice * quantity;
  }

  private resolveLookupPrice(unit: any, usage: ExtendedModelUsage): number {
    const pricingParams = unit.lookup?.pricingParams;
    const prices = unit.lookup?.prices;

    if (!pricingParams?.length || !prices) {
      return 0;
    }

    const lookupValues = pricingParams.map((param: string) => this.getLookupDimensionValue(param, usage));
    if (lookupValues.some((value: string | undefined) => !value)) {
      return 0;
    }

    const lookupKey = lookupValues.join('_');
    const price = prices[lookupKey];

    return typeof price === 'number' ? price : 0;
  }

  private getLookupQuantity(unit: any, usage: ExtendedModelUsage): number {
    switch (unit.unit) {
      case 'image': {
        return usage.images || 0;
      }
      case 'video': {
        return this.getVideoCount(usage);
      }
      case 'second': {
        return usage.videoSeconds || 0;
      }
      default: {
        return 0;
      }
    }
  }

  private getLookupDimensionValue(param: string, usage: ExtendedModelUsage): string | undefined {
    const value = (usage as Record<string, unknown>)[param];

    if (typeof value === 'string' && value.trim()) {
      return value;
    }

    return undefined;
  }

  private getCharacterCount(unitName: string, usage: ExtendedModelUsage): number {
    if (typeof usage.characters === 'number' && usage.characters > 0) {
      return usage.characters;
    }

    this.debug('Character-based billing skipped because no character count exists', {
      unit: unitName,
    });

    return 0;
  }

  /**
   * Get tokens for a specific pricing unit name
   */
  private getTokensForUnit(unitName: string, usage: ExtendedModelUsage): number {
    switch (unitName) {
      case 'textInput': {
        return usage.totalInputTokens || 0;
      }
      case 'textOutput': {
        return usage.totalOutputTokens || 0;
      }
      case 'textInput_cacheRead': {
        return usage.inputCachedTokens || 0;
      }
      case 'textInput_cacheWrite': {
        return usage.inputWriteCacheTokens || 0;
      }
      case 'audioInput': {
        return usage.inputAudioTokens || 0;
      }
      case 'audioOutput': {
        return usage.outputAudioTokens || 0;
      }
      case 'audioInput_cacheRead': {
        return usage.inputCachedAudioTokens || 0;
      }
      case 'imageInput': {
        return usage.inputImageTokens || 0;
      }
      case 'imageOutput': {
        return usage.outputImageTokens || 0;
      }
      case 'videoInput': {
        return usage.inputVideoTokens || 0;
      }
      case 'videoGeneration': {
        return 0; // Video generation is per video, not token-based
      }
      default: {
        return 0;
      }
    }
  }

  /**
   * Get quantity for a unit type
   */
  private getQuantityForUnitType(
    unitType: string,
    unitName: string,
    usage: ExtendedModelUsage,
  ): number {
    switch (unitType) {
      case 'millionTokens': {
        return this.getTokensForUnit(unitName, usage);
      }
      case 'millionCharacters': {
        return this.getCharacterCount(unitName, usage);
      }
      case 'image': {
        return usage.images || 0;
      }
      case 'video': {
        return this.getVideoCount(usage);
      }
      case 'second': {
        return usage.videoSeconds || 0;
      }
      case 'megapixel': {
        return 0; // Not tracked
      }
      default: {
        // Handle additional unit types
        if (unitType === 'minute') {
          return usage.minutes || 0;
        }
        if (unitType === 'request') {
          return usage.requests || 0;
        }
        return 0;
      }
    }
  }
}

/**
 * Calculate credits charge from pricing and usage (standalone helper)
 * Uses billing pricing calculator
 */
export const calculateCharge = (pricing: Pricing, usage: ExtendedModelUsage): number => {
  const pricingOptions = getCreditPricingOptions();
  const billingService = new BillingService(async () => ({ chargedCredits: 0, entry: null }));

  let totalCostUsd = 0;

  for (const unit of pricing.units) {
    const unitCostUsd = billingService['calculateUnitCost'](unit, usage);
    if (unitCostUsd > 0) {
      totalCostUsd += unitCostUsd;
    }
  }

  return calculateCreditsFromCost(totalCostUsd, pricingOptions);
};