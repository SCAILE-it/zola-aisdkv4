import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "../../app/types/database.types"
import { trackTokenUsage } from "../../lib/tools/token-tracking"

export type TokenUsageMetrics = {
  promptTokens?: number | null
  completionTokens?: number | null
  totalTokens?: number | null
}

export type TokenUsageRecorderOptions = {
  supabase?: SupabaseClient<Database> | null
  userId?: string | null
  chatId?: string | null
  model?: string | null
  actionType?: string
}

export type TokenUsageRecorder = (usage?: TokenUsageMetrics | null) => Promise<void>

export type TokenUsageHooks = {
  messageMetadata: ({ part }: { part: any }) =>
    | {
        model?: string
        totalTokens?: number
        promptTokens?: number
        completionTokens?: number
      }
    | void
  onFinish: (args?: {
    usage?: TokenUsageMetrics | null
    response?: { modelId?: string | null } | null
  }) => Promise<void>
}

export function createTokenUsageHooks(
  options: TokenUsageRecorderOptions
): TokenUsageHooks {
  const {
    supabase,
    userId,
    chatId,
    model: defaultModel,
    actionType = "message",
  } = options

  let lastModel = defaultModel ?? undefined
  let pendingTotals: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    model?: string
  } | null = null

  const normalizeNumber = (value?: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0

  const updateUsage = (
    usage?: TokenUsageMetrics | null,
    modelId?: string | null | undefined
  ) => {
    if (!usage) return

    const promptTokens = normalizeNumber(usage.promptTokens)
    const completionTokens = normalizeNumber(usage.completionTokens)
    const totalTokens =
      normalizeNumber(usage.totalTokens) || promptTokens + completionTokens

    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
      return
    }

    if (modelId) {
      lastModel = modelId ?? lastModel
    }

    pendingTotals = {
      promptTokens,
      completionTokens,
      totalTokens,
      model: modelId ?? lastModel ?? defaultModel ?? undefined,
    }
  }

  const messageMetadata = ({ part }: { part: any }) => {
    if (!part) return

    if (part.type === "start") {
      const modelId = part.response?.modelId ?? part.modelId ?? lastModel
      if (modelId) {
        lastModel = modelId
        return { model: modelId }
      }
      return
    }

    if (part.type === "finish") {
      const modelId = part.response?.modelId ?? part.modelId ?? lastModel
      updateUsage(part.totalUsage ?? part.usage ?? null, modelId)

      if (!pendingTotals) {
        if (modelId) {
          return { model: modelId }
        }
        return
      }

      return {
        model: pendingTotals.model ?? modelId,
        totalTokens: pendingTotals.totalTokens,
        promptTokens: pendingTotals.promptTokens,
        completionTokens: pendingTotals.completionTokens,
      }
    }
  }

  const onFinish = async ({
    usage,
    response,
  }: {
    usage?: TokenUsageMetrics | null
    response?: { modelId?: string | null } | null
  } = {}) => {
    updateUsage(usage ?? null, response?.modelId ?? lastModel)

    if (!supabase || !userId || !chatId || !pendingTotals) {
      pendingTotals = null
      return
    }

    const { promptTokens, completionTokens, model: resolvedModel } = pendingTotals

    if (promptTokens === 0 && completionTokens === 0) {
      pendingTotals = null
      return
    }

    await trackTokenUsage(supabase, {
      userId,
      chatId,
      model: resolvedModel ?? defaultModel ?? "unknown-model",
      promptTokens,
      completionTokens,
      actionType,
    })

    pendingTotals = null
  }

  return {
    messageMetadata,
    onFinish,
  }
}

export function createTokenUsageRecorder(
  options: TokenUsageRecorderOptions
): TokenUsageRecorder {
  const hooks = createTokenUsageHooks(options)

  return async (usage?: TokenUsageMetrics | null) => {
    await hooks.onFinish({ usage })
  }
}

