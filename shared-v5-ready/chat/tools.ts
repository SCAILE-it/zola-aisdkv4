import type { SupabaseClient } from "@supabase/supabase-js"
import type { ToolSet } from "ai"
import type { Database } from "@/app/types/database.types"
import { createBulkProcessTool } from "@/lib/tools/bulk-process-tool"
import { createAnalyzeWebsiteTool } from "@/lib/tools/analyze-website"
import { createDeepResearchTool } from "@/lib/tools/deep-research"

export type BaseAgentTools = {
  bulk_process?: ToolSet[string]
  analyze_website?: ToolSet[string]
  deep_research?: ToolSet[string]
}

export type BuildAgentToolsV5Options = {
  supabase: SupabaseClient<Database>
  userId: string
  includeBulkTool: boolean
}

export function buildBaseTools({
  supabase,
  userId,
  includeBulkTool,
}: BuildAgentToolsV5Options): BaseAgentTools {
  const tools: BaseAgentTools = {}

  tools.analyze_website = createAnalyzeWebsiteTool(supabase, userId)
  tools.deep_research = createDeepResearchTool()

  if (includeBulkTool) {
    tools.bulk_process = createBulkProcessTool(supabase, userId)
  }

  return tools
}

export function buildAgentToolsV5(options: BuildAgentToolsV5Options): ToolSet {
  const baseTools = buildBaseTools(options)
  return baseTools as ToolSet
}
