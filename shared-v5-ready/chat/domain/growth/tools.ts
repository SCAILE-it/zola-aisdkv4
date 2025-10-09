import { createGtmExpertTool } from "@/lib/tools/gtm-expert"
import type { BuildAgentToolsV5Options } from "../../tools"
import { buildBaseTools } from "../../chat/tools"

export function buildGrowthTools(options: BuildAgentToolsV5Options): ToolSet {
  const { supabase, userId } = options
  const tools = buildBaseTools(options)

  if (supabase && userId) {
    tools.gtm_expert = createGtmExpertTool(supabase, userId)
  }

  return tools as ToolSet
}
