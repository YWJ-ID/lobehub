import { createHash } from 'node:crypto';
import debug from 'debug';

import {
  type ChatMethodOptions,
  type ChatStreamPayload,
  type EmbeddingsOptions,
  type EmbeddingsPayload,
  type GenerateObjectOptions,
  type GenerateObjectPayload,
  type ModelRuntimeHooks,
} from '@lobechat/model-runtime';
import type { ModelUsage } from '@lobechat/types';

import { getServerDB } from '@/database/core/db-adaptor';
import { CreditModel } from '@/database/models/credit';
import { BillingService } from './credits/billing-service';

const log = debug('lobe:model-runtime:hooks');

/**
 * Only persist usage fields that are needed to identify billing quantity.
 * Excludes raw prompt text and any full payload contents.
 */
const pickStableUsageSummary = (usage?: ModelUsage) => {
  if (!usage) return undefined;

  const summary = {
    acceptedPredictionTokens: usage.acceptedPredictionTokens,
    inputAudioTokens: usage.inputAudioTokens,
    inputCachedAudioTokens: usage.inputCachedAudioTokens,
    inputCachedTokens: usage.inputCachedTokens,
    inputCitationTokens: usage.inputCitationTokens,
    inputImageTokens: usage.inputImageTokens,
    inputToolTokens: usage.inputToolTokens,
    inputVideoTokens: usage.inputVideoTokens,
    inputWriteCacheTokens: usage.inputWriteCacheTokens,
    outputAudioTokens: usage.outputAudioTokens,
    outputImageTokens: usage.outputImageTokens,
    outputReasoningTokens: usage.outputReasoningTokens,
    rejectedPredictionTokens: usage.rejectedPredictionTokens,
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalTokens: usage.totalTokens,
  };

  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
  );
};

const getStablePayloadFingerprint = (payload: {
  messages?: Array<{ content?: unknown; role?: string }>;
  dimensions?: number;
  imageAspectRatio?: string;
  imageResolution?: string;
  input?: string | string[];
  model: string;
  n?: number;
  responseApi?: boolean;
  schema?: { name?: string };
  tool_choice?: string;
  tools?: Array<{ function?: { name?: string }; type?: string }>;
}) => {
  const fingerprint = {
    dimensions: payload.dimensions,
    imageAspectRatio: payload.imageAspectRatio,
    imageResolution: payload.imageResolution,
    inputCount: Array.isArray(payload.input) ? payload.input.length : payload.input ? 1 : undefined,
    inputLengths: Array.isArray(payload.input)
      ? payload.input.map((item) => item.length)
      : typeof payload.input === 'string'
        ? [payload.input.length]
        : undefined,
    messageCount: payload.messages?.length,
    messageRoles: payload.messages?.map((message) => message.role),
    messageSizes: payload.messages?.map((message) => {
      if (typeof message.content === 'string') return message.content.length;
      if (Array.isArray(message.content)) return message.content.length;
      if (message.content && typeof message.content === 'object') {
        return Object.keys(message.content as Record<string, unknown>).length;
      }

      return 0;
    }),
    model: payload.model,
    n: payload.n,
    responseApi: payload.responseApi,
    schemaName: payload.schema?.name,
    toolChoice: payload.tool_choice,
    toolNames: payload.tools?.map((tool) => tool.function?.name || tool.type),
  };

  return Object.fromEntries(Object.entries(fingerprint).filter(([, value]) => value !== undefined));
};

const hashJson = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const getRequestIdentifier = (options?: { headers?: Record<string, any>; metadata?: Record<string, unknown> }) => {
  const metadata = options?.metadata;
  const headers = options?.headers;

  const metadataKeys = [
    'requestId',
    'traceId',
    'messageId',
    'sourceId',
    'idempotencyKey',
    'chatId',
    'callId',
  ] as const;
  for (const key of metadataKeys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }

  const headerKeys = ['x-request-id', 'x-trace-id', 'x-message-id', 'x-idempotency-key'] as const;
  for (const key of headerKeys) {
    const value = headers?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }

  return undefined;
};

const generateSourceId = (
  userId: string,
  provider: string,
  model: string,
  hookType: 'chat' | 'embeddings' | 'generateObject',
  payload: ChatStreamPayload | EmbeddingsPayload | GenerateObjectPayload,
  options: ChatMethodOptions | EmbeddingsOptions | GenerateObjectOptions | undefined,
  usage?: ModelUsage,
): string => {
  const requestId = getRequestIdentifier(options);

  if (requestId) {
    return `${userId}:${provider}:${model}:${hookType}:${requestId}`;
  }

  const payloadFingerprint = getStablePayloadFingerprint(payload as Parameters<typeof getStablePayloadFingerprint>[0]);
  const usageSummary = pickStableUsageSummary(usage);
  const fingerprintHash = hashJson({ payloadFingerprint, usageSummary });

  return `${userId}:${provider}:${model}:${hookType}:${fingerprintHash}`;
};

/**
 * Get business model runtime hooks for credit billing
 * This is called by model runtime module when initializing from DB
 * Returns undefined if hooks cannot be initialized (e.g., DB unavailable)
 */
export async function getBusinessModelRuntimeHooks(
  userId: string,
  provider: string,
): Promise<ModelRuntimeHooks | undefined> {
  try {
    // Initialize billing service with chargeUsage function
    // We use lazy initialization to avoid blocking if DB is not ready
    const getCreditModel = async () => {
      const db = await getServerDB();
      return { db, creditModel: new CreditModel(db, userId) };
    };

    const billingService = new BillingService(async (params) => {
      // Get credit model on-demand
      const { creditModel } = await getCreditModel();
      return creditModel.chargeUsage(params);
    });

    return {
      /**
       * Hook called after chat completion
       * Calculates credits from token usage and charges user
       */
      onChatFinal: async (data, context) => {
        const { usage } = data;
        const { payload } = context;

        if (!usage || !payload?.model) {
          log('[onChatFinal] Missing usage or model, skipping credit charge');
          return;
        }

        try {
          const model = payload.model;
          const sourceId = generateSourceId(userId, provider, model, 'chat', payload, context.options, usage);

          log(
            '[onChatFinal] Charging credits for chat - model: %s, provider: %s, sourceId: %s',
            model,
            provider,
            sourceId,
          );

          const result = await billingService.calculateAndChargeTextUsage({
            model,
            provider,
            usage,
            sourceId,
          });

          log('[onChatFinal] Charged %d credits for model: %s', result.chargedCredits, model);
        } catch (error) {
          // Hook failures should not interfere with response completion
          log('[onChatFinal] Failed to charge credits: %O', error);
        }
      },

      /**
       * Hook called after embeddings completion
       * Calculates credits from token usage and charges user
       */
      onEmbeddingsFinal: async (data, context) => {
        const { usage } = data;
        const { payload } = context;

        if (!usage || !payload?.model) {
          log('[onEmbeddingsFinal] Missing usage or model, skipping credit charge');
          return;
        }

        try {
          const model = payload.model;
          const sourceId = generateSourceId(
            userId,
            provider,
            model,
            'embeddings',
            payload,
            context.options,
            usage,
          );

          log(
            '[onEmbeddingsFinal] Charging credits for embeddings - model: %s, provider: %s, sourceId: %s',
            model,
            provider,
            sourceId,
          );

          const result = await billingService.calculateAndChargeTextUsage({
            model,
            provider,
            usage,
            sourceId,
          });

          log(
            '[onEmbeddingsFinal] Charged %d credits for embeddings model: %s',
            result.chargedCredits,
            model,
          );
        } catch (error) {
          log('[onEmbeddingsFinal] Failed to charge credits: %O', error);
        }
      },

      /**
       * Hook called after structured object generation completion
       * Calculates credits from token usage and charges user
       */
      onGenerateObjectFinal: async (data, context) => {
        const { usage } = data;
        const { payload } = context;

        if (!usage || !payload?.model) {
          log('[onGenerateObjectFinal] Missing usage or model, skipping credit charge');
          return;
        }

        try {
          const model = payload.model;
          const sourceId = generateSourceId(
            userId,
            provider,
            model,
            'generateObject',
            payload,
            context.options,
            usage,
          );

          log(
            '[onGenerateObjectFinal] Charging credits for generateObject - model: %s, provider: %s, sourceId: %s',
            model,
            provider,
            sourceId,
          );

          const result = await billingService.calculateAndChargeTextUsage({
            model,
            provider,
            usage,
            sourceId,
          });

          log(
            '[onGenerateObjectFinal] Charged %d credits for generateObject model: %s',
            result.chargedCredits,
            model,
          );
        } catch (error) {
          log('[onGenerateObjectFinal] Failed to charge credits: %O', error);
        }
      },
    };
  } catch (error) {
    log('[getBusinessModelRuntimeHooks] Failed to initialize hooks: %O', error);
    return undefined;
  }
}