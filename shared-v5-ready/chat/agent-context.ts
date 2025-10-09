import type { SupabaseClient } from "@supabase/supabase-js"
import type { ToolSet } from "ai"
import type { Database } from "@/app/types/database.types"
import { SYSTEM_PROMPT_DEFAULT } from "@/lib/config"
import { createClient as createSupabaseClient } from "@/lib/supabase/server"
import { buildAgentToolsV5 } from "./tools"

export type BuildAgentToolsOptions = {
  supabase?: SupabaseClient<Database> | null
  userId?: string | null
  includeBulkTool?: boolean
}

export function resolveSystemPrompt(systemPrompt?: string | null): string {
  if (systemPrompt && systemPrompt.trim().length > 0) {
    return systemPrompt
  }

  return SYSTEM_PROMPT_DEFAULT
}

export function buildAgentTools(options: BuildAgentToolsOptions): ToolSet {
  const { supabase, userId, includeBulkTool = true } = options

  if (!supabase || !userId) {
    return {}
  }

  return buildAgentToolsV5({
    supabase,
    userId,
    includeBulkTool,
  })
}

export async function resolveServerSupabase(): Promise<SupabaseClient<Database> | null> {
  try {
    return await createSupabaseClient()
  } catch (error) {
    console.error("Failed to create Supabase server client (v5 compatible):", error)
    return null
  }
}
