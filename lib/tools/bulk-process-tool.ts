import { tool } from "ai"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import type { Database } from "@/app/types/database.types"
import { fetchCsvContent } from "@/lib/bulk-processing/fetch-csv"
import {
  parseCSV,
  generateExecutionPlan,
} from "@/lib/bulk-processing/processor"
import { MODEL_DEFAULT } from "@/lib/config"
import type {
  CompleteStage,
  ErrorStage,
  ExecutingStage,
  PlanStage,
} from "./heavy-tool/types"

const ToolParamsSchema = z.object({
  stage: z.enum(["plan", "execute"]).default("plan"),
  csvUrl: z
    .string()
    .url()
    .optional()
    .describe("Public URL of the CSV to process."),
  csvContent: z
    .string()
    .optional()
    .describe("Direct CSV content as a string."),
  promptTemplate: z
    .string()
    .min(1)
    .describe("Prompt template with {{variable}} placeholders."),
  model: z.string().default(MODEL_DEFAULT),
  mode: z.enum(["sample", "full"]).optional(),
  refinements: z.string().optional(),
})

const StageBaseSchema = z.object({
  toolName: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.unknown()).optional(),
})

const PlanStageSchema = StageBaseSchema.extend({
  type: z.literal("plan"),
  markdown: z.string(),
  csvPreview: z
    .object({
      headers: z.array(z.string()),
      sampleRows: z.array(z.array(z.string())),
      totalRows: z.number(),
    })
    .optional(),
  estimates: z.object({
    cost: z.number(),
    time: z.string(),
    rowsToProcess: z.number(),
  }),
})

const ExecutingStageSchema = StageBaseSchema.extend({
  type: z.literal("executing"),
  executionId: z.string(),
  mode: z.enum(["sample", "full"]),
  progress: z.object({
    current: z.number(),
    total: z.number(),
    currentRow: z.string().optional(),
  }),
})

const CompleteStageSchema = StageBaseSchema.extend({
  type: z.literal("complete"),
  executionId: z.string(),
  summary: z.object({
    totalProcessed: z.number(),
    successful: z.number(),
    failed: z.number(),
    totalCost: z.number(),
  }),
  downloadUrl: z.string(),
})

const ErrorStageSchema = StageBaseSchema.extend({
  type: z.literal("error"),
  error: z.string(),
  canRetry: z.boolean(),
})

const BulkProcessResultSchema = z.object({
  stage: z.union([
    PlanStageSchema,
    ExecutingStageSchema,
    CompleteStageSchema,
    ErrorStageSchema,
  ]),
})

export const createBulkProcessTool = (
  supabase: SupabaseClient<Database>,
  userId: string
) => {
  const inputSchema = ToolParamsSchema
  const outputSchema = BulkProcessResultSchema

  return tool({
    description:
      "Generate and execute a bulk processing plan against a CSV file. Produces a plan with validation, sample prompts, and execution estimates.",
    // @ts-expect-error: `inputSchema` is the v5 property; keep `parameters` for backwards compatibility until all callsites move over.
    inputSchema,
    parameters: inputSchema,
    // @ts-expect-error: `outputSchema` is available in the v5 tool builder API.
    outputSchema,
    execute: async ({ stage, csvUrl, csvContent, promptTemplate, model, mode, refinements }) => {
      if (stage === "plan") {
        try {
          // Get CSV content either from URL or direct content
          let csv: string
          if (csvContent) {
            csv = csvContent
          } else if (csvUrl) {
            csv = await fetchCsvContent(csvUrl)
          } else {
            throw new Error("Either csvUrl or csvContent must be provided")
          }
          
          const csvData = parseCSV(csv)

          if (!csvData.length) {
            const errorStage: ErrorStage = {
              type: "error",
              toolName: "bulk_process",
              timestamp: new Date().toISOString(),
              error: "The provided CSV is empty. Please upload a file with at least one data row.",
              canRetry: false,
            }
            return { stage: errorStage }
          }

          const planPreview = generateExecutionPlan(csvData, promptTemplate, model)

          if (!planPreview.valid) {
            const errorStage: ErrorStage = {
              type: "error",
              toolName: "bulk_process",
              timestamp: new Date().toISOString(),
              error: planPreview.errors.join("\n"),
              canRetry: false,
            }
            return { stage: errorStage }
          }

          const headers = Object.keys(csvData[0] ?? {})
          const previewRows = csvData
            .slice(0, 3)
            .map((row) => headers.map((header) => row[header] ?? ""))

          const planStage: PlanStage = {
            type: "plan",
            toolName: "bulk_process",
            timestamp: new Date().toISOString(),
            markdown: [
              "## Bulk Processing Plan",
              `- **Rows detected:** ${planPreview.preview.totalRows}`,
              `- **Estimated tokens:** ${planPreview.preview.estimatedTokens.toLocaleString()}`,
              `- **Estimated cost:** $${planPreview.preview.estimatedCost.toFixed(2)}`,
              refinements
                ? `### Refinements\n\n${refinements}`
                : "",
              "### Sample prompts",
              planPreview.preview.samplePrompts
                .map((prompt, index) => `**Row ${index + 1}:**\n\n${prompt}`)
                .join("\n\n---\n\n"),
            ]
              .filter(Boolean)
              .join("\n\n"),
            csvPreview: {
              headers,
              sampleRows: previewRows,
              totalRows: csvData.length,
            },
            estimates: {
              cost: planPreview.preview.estimatedCost,
              time: planPreview.preview.totalRows
                ? `~${Math.max(1, Math.ceil(planPreview.preview.totalRows / 2))} min`
                : "~1 min",
              rowsToProcess: planPreview.preview.totalRows,
            },
            metadata: {
              model,
              promptTemplate,
              csvUrl,
              csvString: csvContent,
            },
          }

          return {
            stage: {
              ...planStage,
              metadata: {
                ...planStage.metadata,
                plan: planPreview,
                execution: {
                  payload: {
                    endpoint: "/api/bulk-process/run",
                    action: "execute",
                    mode: mode ?? "full",
                    promptTemplate,
                    model,
                  },
                },
              },
            },
          }
        } catch (error) {
          const errorStage: ErrorStage = {
            type: "error",
            toolName: "bulk_process",
            timestamp: new Date().toISOString(),
            error:
              error instanceof Error
                ? error.message
                : "Failed to analyze CSV file.",
            canRetry: false,
          }
          return { stage: errorStage }
        }
      }

      return {
        stage: {
          type: "error",
          toolName: "bulk_process",
          timestamp: new Date().toISOString(),
          error: "Use /api/bulk-process with action=execute to run this plan.",
          canRetry: false,
          metadata: {
            mode: mode ?? "full",
          },
        },
      }
    },
    onError: ({ error }) => {
      const message =
        error instanceof Error ? error.message : "Bulk processing tool encountered an unexpected error."

      return {
        stage: {
          type: "error",
          toolName: "bulk_process",
          timestamp: new Date().toISOString(),
          error: message,
          canRetry: false,
        } satisfies ErrorStage,
      }
    },
  })
}

