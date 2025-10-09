import { streamText } from "ai"
import type { ToolSet } from "ai"
import type { Message as MessageAISDK } from "@ai-sdk/react"
import type { Attachment } from "@ai-sdk/ui-utils"
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

import type { Database } from "@/app/types/database.types"
import type { Message as ApiMessage } from "@/app/types/api.types"
import { logUserMessage, storeAssistantMessage } from "@/app/api/chat/api"
import { FEATURE_FLAGS, SYSTEM_PROMPT_DEFAULT } from "@/lib/config"
import { getAllModels } from "@/lib/models"
import { getProviderForModel } from "@/lib/openproviders/provider-map"
import { createAnalyzeWebsiteTool } from "@/lib/tools/analyze-website"
import { createBulkProcessTool } from "@/lib/tools/bulk-process-tool"
import { createDeepResearchTool } from "@/lib/tools/deep-research"
import { createGtmExpertTool } from "@/lib/tools/gtm-expert"
import { createTokenUsageHooks } from "@/shared-v5-ready/token-usage"

type PromptQueueJobPayload = {
  messages: MessageAISDK[]
  model: string
  systemPrompt?: string | null
  enableSearch?: boolean
  isAuthenticated: boolean
  attachments?: Attachment[]
}

type PromptQueueMetadata = {
  messageGroupId?: string
  [key: string]: unknown
}

type PromptQueueJob = {
  id: string
  user_id: string
  chat_id: string
  model: string
  system_prompt: string | null
  enable_search: boolean
  is_authenticated: boolean
  messages: MessageAISDK[]
  attachments: Attachment[]
  attempt_count: number
  metadata: PromptQueueMetadata | null
  message_group_id: string | null
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET || "change_me_in_production"

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE

    if (!supabaseUrl || !serviceRole) {
      return NextResponse.json(
        { error: "Supabase service credentials missing" },
        { status: 503 }
      )
    }

    const supabase = createClient<Database>(supabaseUrl, serviceRole, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const processed: Array<{
      id: string
      status: "completed" | "failed"
      error?: string
    }> = []

    while (true) {
      const { data, error } = await supabase.rpc("prompt_queue_acquire")

      if (error) {
        console.error("Failed to acquire queue job", error)
        return NextResponse.json(
          { error: "Failed to acquire queue job" },
          { status: 500 }
        )
      }

      if (!data || data.length === 0) {
        break
      }

      const rawJob = data[0]

      const job: PromptQueueJob = {
        id: rawJob.id,
        user_id: rawJob.user_id,
        chat_id: rawJob.chat_id,
        model: rawJob.model,
        system_prompt: rawJob.system_prompt,
        enable_search: rawJob.enable_search,
        is_authenticated: rawJob.is_authenticated,
        messages: (rawJob.messages as unknown as MessageAISDK[]) ?? [],
        attachments: (rawJob.attachments as unknown as Attachment[]) ?? [],
        attempt_count: rawJob.attempt_count,
        metadata: (rawJob.metadata as PromptQueueMetadata | null) ?? null,
        message_group_id: rawJob.message_group_id,
      }

      try {
        await processQueueJob(supabase, job)
        processed.push({ id: job.id, status: "completed" })
      } catch (err) {
        const message = (err as Error).message || "Unknown error"
        processed.push({ id: job.id, status: "failed", error: message })
      }
    }

    return NextResponse.json(
      {
        success: true,
        processed,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("Unexpected error processing queue", error)
    return NextResponse.json(
      { error: (error as Error).message ?? "Unexpected error" },
      { status: 500 }
    )
  }
}

async function processQueueJob(
  supabase: ReturnType<typeof createClient<Database>>,
  job: PromptQueueJob
) {
  const payload: PromptQueueJobPayload = {
    messages: job.messages,
    model: job.model,
    systemPrompt: job.system_prompt,
    enableSearch: job.enable_search,
    isAuthenticated: job.is_authenticated,
    attachments: job.attachments,
  }
  if (!payload.messages || payload.messages.length === 0) {
    await markJobFailed(supabase, job.id, "Invalid job payload")
    throw new Error("Invalid job payload")
  }

  const metadata = (job.metadata ?? {}) as PromptQueueMetadata
  const attachments = payload.attachments ?? []
  const enableSearch = payload.enableSearch ?? true

  const allModels = await getAllModels()
  const modelConfig = allModels.find((m) => m.id === payload.model)

  if (!modelConfig || !modelConfig.apiSdk) {
    await markJobFailed(supabase, job.id, `Model ${payload.model} not found`)
    throw new Error(`Model ${payload.model} not found`)
  }

  let apiKey: string | undefined
  if (payload.isAuthenticated) {
    const { getEffectiveApiKey } = await import("@/lib/user-keys")
    const provider = getProviderForModel(payload.model)
    apiKey =
      (await getEffectiveApiKey(
        job.user_id,
        provider as import("@/lib/user-keys").ProviderWithoutOllama
      )) || undefined
  }

  const tools: ToolSet = {}

  tools.gtm_expert = createGtmExpertTool(supabase, job.user_id)
  tools.analyze_website = createAnalyzeWebsiteTool(supabase, job.user_id)
  tools.deep_research = createDeepResearchTool()

  if (FEATURE_FLAGS.HEAVY_TOOLS) {
    tools.bulk_process = createBulkProcessTool(supabase, job.user_id)
  }

  const userMessage = payload.messages[payload.messages.length - 1]
  const userContent = serializeMessageContent(userMessage?.content)

  if (userMessage?.role === "user" && userContent) {
    await logUserMessage({
      supabase,
      userId: job.user_id,
      chatId: job.chat_id,
      content: userContent,
      attachments,
      model: payload.model,
      isAuthenticated: payload.isAuthenticated,
      message_group_id: metadata.messageGroupId,
    })
  }

  try {
    const result = await streamText({
      model: modelConfig.apiSdk(apiKey, { enableSearch }),
      system: payload.systemPrompt ?? SYSTEM_PROMPT_DEFAULT,
      messages: payload.messages,
      tools,
      maxSteps: 10,
    })

    let assistantText = ""
    for await (const chunk of result.textStream) {
      assistantText += chunk
    }

    const response = await result.response
    const usage = await result.usage

    const tokenUsage = createTokenUsageHooks({
      supabase,
      userId: job.user_id,
      chatId: job.chat_id,
      model: payload.model,
      actionType: "message",
    })

    await storeAssistantMessage({
      supabase,
      chatId: job.chat_id,
      messages: response.messages as ApiMessage[],
      message_group_id: metadata.messageGroupId,
      model: payload.model,
    })

    await tokenUsage.onFinish({ usage, response })

    await supabase
      .from("prompt_queue")
      .update({
        status: "completed",
        finished_at: new Date().toISOString(),
        metadata: { ...metadata, assistantText },
      })
      .eq("id", job.id)
  } catch (error) {
    const message = (error as Error).message || "Failed to process job"
    await markJobFailed(supabase, job.id, message)
    throw error
  }
}

async function markJobFailed(
  supabase: ReturnType<typeof createClient<Database>>,
  jobId: string,
  message: string
) {
  await supabase
    .from("prompt_queue")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: { message },
    })
    .eq("id", jobId)
}

function serializeMessageContent(content: MessageAISDK["content"]) {
  if (!content) return ""
  if (typeof content === "string") return content
  try {
    return JSON.stringify(content)
  } catch {
    return ""
  }
}

