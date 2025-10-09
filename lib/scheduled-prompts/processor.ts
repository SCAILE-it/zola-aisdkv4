import { streamText } from "ai"
import { SupabaseClient } from "@supabase/supabase-js"
import { Database } from "@/app/types/database.types"
import { getAllModels } from "@/lib/models"
import { createTokenUsageHooks } from "@/shared-v5-ready/token-usage"
import { createGtmExpertTool } from "@/lib/tools/gtm-expert"
import { createAnalyzeWebsiteTool } from "@/lib/tools/analyze-website"

export interface ScheduledPrompt {
  id: string
  user_id: string
  prompt: string
  schedule_type: "once" | "daily" | "weekly" | "monthly"
  schedule_time?: string
  schedule_date?: string
  delivery_method: "chat" | "email" | "webhook"
  delivery_config?: any
  is_active: boolean
  last_run_at?: string
  next_run_at?: string
}

export interface ExecutePromptResult {
  success: boolean
  promptId: string
  output: string
  error?: string
  tokensUsed?: number
}

// Execute a scheduled prompt
export async function executeScheduledPrompt(
  supabase: SupabaseClient<Database>,
  prompt: ScheduledPrompt,
  model = "gemini-2.5-flash"
): Promise<ExecutePromptResult> {
  try {
    // Get model config
    const allModels = await getAllModels()
    const modelConfig = allModels.find((m) => m.id === model)

    if (!modelConfig || !modelConfig.apiSdk) {
      throw new Error(`Model ${model} not found`)
    }

    // Build tools (same as chat)
    const tools: any = {
      gtm_expert: createGtmExpertTool(supabase, prompt.user_id),
      analyze_website: createAnalyzeWebsiteTool(supabase, prompt.user_id),
    }

    const tokenUsage = createTokenUsageHooks({
      supabase,
      userId: prompt.user_id,
      chatId: prompt.id,
      model,
      actionType: "scheduled_prompt",
    })

    // Execute prompt with AI
    const response = await streamText({
      model: modelConfig.apiSdk(),
      messages: [
        {
          role: "user",
          content: prompt.prompt,
        },
      ],
      tools,
      maxSteps: 10,
    })

    // Collect output
    let output = ""
    for await (const chunk of response.textStream) {
      output += chunk
    }

    // Get usage
    const usage = await response.usage
    const finalResponse = await response.response

    // Track tokens
    await tokenUsage.onFinish({ usage, response: finalResponse })

    return {
      success: true,
      promptId: prompt.id,
      output: output.trim(),
      tokensUsed: usage?.totalTokens,
    }
  } catch (error: any) {
    console.error("Scheduled prompt execution error:", error)
    return {
      success: false,
      promptId: prompt.id,
      output: "",
      error: error.message || "Execution failed",
    }
  }
}

// Process due scheduled prompts (called by cron job)
export async function processDuePrompts(supabase: SupabaseClient<Database>) {
  try {
    const now = new Date().toISOString()

    // Get prompts that are due
    const { data: duePrompts, error } = await supabase
      .from("scheduled_prompts")
      .select("*")
      .eq("is_active", true)
      .lte("next_run_at", now)
      .order("next_run_at", { ascending: true })

    if (error) {
      console.error("Error fetching due prompts:", error)
      return
    }

    if (!duePrompts || duePrompts.length === 0) {
      console.log("No due prompts to process")
      return
    }

    console.log(`Processing ${duePrompts.length} due prompts`)

    // Process each prompt
    for (const prompt of duePrompts) {
      try {
        console.log(`Executing prompt ${prompt.id} for user ${prompt.user_id}`)

        const result = await executeScheduledPrompt(
          supabase,
          prompt as ScheduledPrompt
        )

        if (result.success) {
          // Deliver result based on delivery method
          await deliverResult(supabase, prompt as ScheduledPrompt, result.output)

          // Update last_run_at and recalculate next_run_at (database trigger will handle this)
          await supabase
            .from("scheduled_prompts")
            .update({
              last_run_at: new Date().toISOString(),
            })
            .eq("id", prompt.id)

          console.log(`Prompt ${prompt.id} executed successfully`)
        } else {
          console.error(`Prompt ${prompt.id} execution failed:`, result.error)
        }
      } catch (error) {
        console.error(`Error processing prompt ${prompt.id}:`, error)
      }
    }
  } catch (error) {
    console.error("Error in processDuePrompts:", error)
  }
}

// Deliver the result based on delivery method
async function deliverResult(
  supabase: SupabaseClient<Database>,
  prompt: ScheduledPrompt,
  output: string
) {
  try {
    if (prompt.delivery_method === "chat") {
      // Create a new chat for the scheduled prompt result
      const { data: chat, error: chatError } = await supabase
        .from("chats")
        .insert({
          user_id: prompt.user_id,
          title: `Scheduled: ${prompt.prompt.substring(0, 50)}...`,
        })
        .select()
        .single()

      if (chatError || !chat) {
        console.error("Error creating chat:", chatError)
        return
      }

      // Store the result as a message
      await supabase.from("messages").insert([
        {
          chat_id: chat.id,
          role: "user",
          content: prompt.prompt,
        },
        {
          chat_id: chat.id,
          role: "assistant",
          content: output,
        },
      ])
    } else if (prompt.delivery_method === "email") {
      // TODO: Implement email delivery
      console.log("Email delivery not yet implemented")
    } else if (prompt.delivery_method === "webhook") {
      // TODO: Implement webhook delivery
      const webhookUrl = prompt.delivery_config?.webhook_url
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            promptId: prompt.id,
            prompt: prompt.prompt,
            output,
            timestamp: new Date().toISOString(),
          }),
        })
      }
    }
  } catch (error) {
    console.error("Error delivering result:", error)
  }
}

// Validate schedule configuration
export function validateSchedule(
  scheduleType: string,
  scheduleTime?: string,
  scheduleDate?: string
): { valid: boolean; error?: string } {
  if (scheduleType === "once") {
    if (!scheduleDate) {
      return { valid: false, error: "Schedule date required for one-time prompts" }
    }
    const date = new Date(scheduleDate)
    if (isNaN(date.getTime())) {
      return { valid: false, error: "Invalid schedule date" }
    }
    if (date < new Date()) {
      return { valid: false, error: "Schedule date must be in the future" }
    }
  } else if (["daily", "weekly", "monthly"].includes(scheduleType)) {
    if (!scheduleTime) {
      return { valid: false, error: "Schedule time required for recurring prompts" }
    }
    // Validate time format (HH:MM)
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/
    if (!timeRegex.test(scheduleTime)) {
      return { valid: false, error: "Invalid time format (use HH:MM)" }
    }
  } else {
    return { valid: false, error: "Invalid schedule type" }
  }

  return { valid: true }
}


