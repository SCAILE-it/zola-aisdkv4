import { FEATURE_FLAGS, SYSTEM_PROMPT_DEFAULT } from "@/lib/config"
import { getAllModels } from "@/lib/models"
import { getProviderForModel } from "@/lib/openproviders/provider-map"
import type { ProviderWithoutOllama } from "@/lib/user-keys"
import {
  convertToModelMessages,
  streamText,
  type FileUIPart,
  type ToolSet,
  type UIMessage,
} from "ai"
import {
  incrementMessageCount,
  logUserMessage,
  storeAssistantMessage,
  validateAndTrackUsage,
} from "./api"
import { createErrorResponse, extractErrorMessage } from "./utils"
import { createGtmExpertTool } from "@/lib/tools/gtm-expert"
import { createAnalyzeWebsiteTool } from "@/lib/tools/analyze-website"
import { createBulkProcessTool } from "@/lib/tools/bulk-process-tool"
import { createDeepResearchTool } from "@/lib/tools/deep-research"
import { createTokenUsageHooks } from "@/shared-v5-ready/token-usage"
import {
  filePartsToAttachments,
  getFileParts,
  getTextContent,
} from "@/lib/message-utils"

export const maxDuration = 60

type ChatRequest = {
  messages: UIMessage[]
  chatId: string
  userId: string
  model: string
  isAuthenticated: boolean
  systemPrompt: string
  enableSearch: boolean
  message_group_id?: string
}

export async function POST(req: Request) {
  try {
    const {
      messages,
      chatId,
      userId,
      model,
      isAuthenticated,
      systemPrompt,
      enableSearch,
      message_group_id,
    } = (await req.json()) as ChatRequest

    if (!messages || !chatId || !userId) {
      return new Response(
        JSON.stringify({ error: "Error, missing information" }),
        { status: 400 }
      )
    }

    const supabase = await validateAndTrackUsage({
      userId,
      model,
      isAuthenticated,
      request: req,
    })

    // Increment message count for successful validation
    if (supabase) {
      await incrementMessageCount({ supabase, userId })
    }

    const userMessage = messages[messages.length - 1]

    if (supabase && userMessage?.role === "user") {
      const textContent = getTextContent(userMessage)
      const fileParts = getFileParts(userMessage) as FileUIPart[]

      await logUserMessage({
        supabase,
        userId,
        chatId,
        content: textContent,
        attachments: filePartsToAttachments(fileParts),
        model,
        isAuthenticated,
        message_group_id,
      })
    }

    const allModels = await getAllModels()
    const modelConfig = allModels.find((m) => m.id === model)

    if (!modelConfig || !modelConfig.apiSdk) {
      throw new Error(`Model ${model} not found`)
    }

    const effectiveSystemPrompt = systemPrompt || SYSTEM_PROMPT_DEFAULT

    let apiKey: string | undefined
    if (isAuthenticated && userId) {
      const { getEffectiveApiKey } = await import("@/lib/user-keys")
      const provider = getProviderForModel(model)
      apiKey =
        (await getEffectiveApiKey(userId, provider as ProviderWithoutOllama)) ||
        undefined
    }

    // Build tools object - include all available tools when Supabase context is present
    const tools: ToolSet = {}

    if (supabase && userId) {
      tools.gtm_expert = createGtmExpertTool(supabase, userId)
      tools.analyze_website = createAnalyzeWebsiteTool(supabase, userId)
      tools.deep_research = createDeepResearchTool()

      if (FEATURE_FLAGS.HEAVY_TOOLS) {
        tools.bulk_process = createBulkProcessTool(supabase, userId)
      }
    }

    const modelMessages = convertToModelMessages(messages)

    const tokenUsage = createTokenUsageHooks({
      supabase,
      userId,
      chatId,
      model,
      actionType: "message",
    })

    const result = streamText({
      model: modelConfig.apiSdk(apiKey, { enableSearch: enableSearch ?? true }),
      system: systemPrompt || SYSTEM_PROMPT_DEFAULT,
      messages: modelMessages,
      tools,
      onError: (err: unknown) => {
        console.error("Streaming error occurred:", err)
      },

      onFinish: async ({ response, usage }) => {
        if (supabase) {
          await storeAssistantMessage({
            supabase,
            chatId,
            messages:
              response.messages as unknown as import("@/app/types/api.types").Message[],
            message_group_id,
            model,
          })
        }

        await tokenUsage.onFinish({ usage, response })
      },
    })

    return result.toUIMessageStreamResponse({
      sendReasoning: true,
      sendSources: true,
      messageMetadata: tokenUsage.messageMetadata,
      onError: (error: unknown) => {
        console.error("Error forwarded to client:", error)
        return extractErrorMessage(error)
      },
    })
  } catch (err: unknown) {
    console.error("Error in /api/chat:", err)
    const error = err as {
      code?: string
      message?: string
      statusCode?: number
    }

    return createErrorResponse(error)
  }
}
