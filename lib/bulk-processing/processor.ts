import type { SupabaseClientType } from "@/app/types/api.types"
import { getAllModels } from "@/lib/models"
import { createTokenUsageHooks } from "@/shared-v5-ready/token-usage"
import { streamText } from "ai"

export type CsvRow = Record<string, string>

export interface BulkProcessingOptions {
  csvData: CsvRow[]
  promptTemplate: string
  model: string
  userId: string
  chatId: string
  supabase: SupabaseClientType
  apiKey?: string
  onProgress?: (current: number, total: number, result: string) => void
  mode?: "sample" | "full"
}

export interface BulkProcessingResult {
  success: boolean
  processedRows: number
  totalRows: number
  results: Array<{
    rowIndex: number
    input: CsvRow
    output: string
    error?: string
  }>
  totalTokens: number
  totalCost: number
}

// Parse CSV string to array of objects
export function parseCSV(csvString: string): CsvRow[] {
  const lines = csvString.trim().split("\n")
  if (lines.length < 2) {
    throw new Error("CSV must have at least a header row and one data row")
  }

  const headers = lines[0].split(",").map((h) => h.trim())
  const rows: CsvRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim())
    if (values.length !== headers.length) {
      console.warn(`Row ${i} has mismatched column count, skipping`)
      continue
    }

    const row: CsvRow = {}
    headers.forEach((header, index) => {
      row[header] = values[index]
    })
    rows.push(row)
  }

  return rows
}

// Replace template variables in prompt
export function replaceTemplateVariables(template: string, row: CsvRow): string {
  let result = template
  Object.keys(row).forEach((key) => {
    const placeholder = `{{${key}}}`
    result = result.replace(new RegExp(placeholder, "g"), row[key])
  })
  return result
}

// Extract template variables from prompt
export function extractTemplateVariables(template: string): string[] {
  const matches = template.match(/\{\{([^}]+)\}\}/g)
  if (!matches) return []
  return matches.map((match) => match.replace(/\{\{|\}\}/g, "").trim())
}

// Validate that all template variables exist in CSV headers
export function validateTemplate(
  template: string,
  headers: string[]
): { valid: boolean; missingVariables: string[] } {
  const templateVars = extractTemplateVariables(template)
  const missingVariables = templateVars.filter((v) => !headers.includes(v))

  return {
    valid: missingVariables.length === 0,
    missingVariables,
  }
}

// Process bulk CSV
export async function processBulkCSV(
  options: BulkProcessingOptions
): Promise<BulkProcessingResult> {
  const { csvData, promptTemplate, model, userId, chatId, supabase, apiKey, onProgress, mode = "full" } = options

  const result: BulkProcessingResult = {
    success: true,
    processedRows: 0,
    totalRows: mode === "sample" ? Math.min(3, csvData.length) : csvData.length,
    results: [],
    totalTokens: 0,
    totalCost: 0,
  }

  // Get model config
  const allModels = await getAllModels()
  const modelConfig = allModels.find((m) => m.id === model)

  if (!modelConfig || !modelConfig.apiSdk) {
    throw new Error(`Model ${model} not found`)
  }

  // Process rows
  const rowsToProcess = mode === "sample" ? csvData.slice(0, 3) : csvData

  for (let i = 0; i < rowsToProcess.length; i++) {
    const row = rowsToProcess[i]

    try {
      // Replace template variables
      const prompt = replaceTemplateVariables(promptTemplate, row)

      const tokenUsage = createTokenUsageHooks({
        supabase,
        userId,
        chatId,
        model,
        actionType: "bulk_process",
      })

      // Call AI with the personalized prompt
      const response = await streamText({
        model: modelConfig.apiSdk(apiKey),
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        maxSteps: 5, // Limit steps for bulk processing
      })

      // Collect the streamed response
      let output = ""
      for await (const chunk of response.textStream) {
        output += chunk
      }

      // Get usage info
      const usage = await response.usage
      const finalResponse = await response.response

      // Track tokens
      if (usage) {
        result.totalTokens += usage.totalTokens
      }

      await tokenUsage.onFinish({ usage, response: finalResponse })

      result.results.push({
        rowIndex: i,
        input: row,
        output: output.trim(),
      })

      result.processedRows++

      // Call progress callback
      if (onProgress) {
        onProgress(i + 1, result.totalRows, output.trim())
      }
    } catch (error: any) {
      console.error(`Error processing row ${i}:`, error)
      result.results.push({
        rowIndex: i,
        input: row,
        output: "",
        error: error.message || "Processing failed",
      })
      result.success = false
    }
  }

  return result
}

// Generate execution plan (before running bulk process)
export function generateExecutionPlan(
  csvData: CsvRow[],
  promptTemplate: string,
  model: string
): {
  valid: boolean
  errors: string[]
  preview: {
    totalRows: number
    samplePrompts: string[]
    estimatedTokens: number
    estimatedCost: number
  }
} {
  const errors: string[] = []

  // Validate CSV
  if (csvData.length === 0) {
    errors.push("CSV data is empty")
  }

  // Validate template
  const headers = csvData.length > 0 ? Object.keys(csvData[0]) : []
  const templateValidation = validateTemplate(promptTemplate, headers)

  if (!templateValidation.valid) {
    errors.push(
      `Missing CSV columns for variables: ${templateValidation.missingVariables.join(", ")}`
    )
  }

  // Generate sample prompts
  const samplePrompts = csvData.slice(0, 3).map((row) => replaceTemplateVariables(promptTemplate, row))

  // Estimate tokens (rough estimate: ~4 chars = 1 token)
  const avgPromptLength = samplePrompts.reduce((sum, p) => sum + p.length, 0) / samplePrompts.length
  const estimatedTokensPerRow = Math.ceil(avgPromptLength / 4) + 500 // +500 for response
  const estimatedTokens = estimatedTokensPerRow * csvData.length

  // Estimate cost (using Gemini Flash pricing)
  const estimatedCost = (estimatedTokens / 1_000_000) * 0.2 // Rough average

  return {
    valid: errors.length === 0,
    errors,
    preview: {
      totalRows: csvData.length,
      samplePrompts,
      estimatedTokens,
      estimatedCost,
    },
  }
}

// Convert results to CSV
export function resultsToCSV(
  originalData: CsvRow[],
  results: BulkProcessingResult["results"],
  outputColumnName = "AI_Output"
): string {
  if (originalData.length === 0) return ""

  const headers = Object.keys(originalData[0])
  const csvHeaders = [...headers, outputColumnName].join(",")

  const csvRows = results.map((result) => {
    const originalRow = originalData[result.rowIndex]
    const values = headers.map((h) => `"${originalRow[h]}"`)
    const output = result.error ? `ERROR: ${result.error}` : result.output
    values.push(`"${output.replace(/"/g, '""')}"`) // Escape quotes
    return values.join(",")
  })

  return [csvHeaders, ...csvRows].join("\n")
}


