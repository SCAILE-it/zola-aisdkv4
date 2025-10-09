import type { SupabaseClientType } from "@/app/types/api.types"
import { NextRequest, NextResponse } from "next/server"

import {
  parseCSV,
  generateExecutionPlan,
  processBulkCSV,
  resultsToCSV,
  CsvRow,
} from "@/lib/bulk-processing/processor"
import { validateUserIdentity } from "@/lib/server/api"
import { getEffectiveApiKey } from "@/lib/user-keys"
import { getProviderForModel } from "@/lib/openproviders/provider-map"
import type { ProviderWithoutOllama } from "@/lib/user-keys"
import {
  isTestAuthBypass,
  resolveBypassUserId,
} from "@/shared-v5-ready/auth-bypass/bypass"

export const maxDuration = 300 // 5 minutes for bulk processing

// POST /api/bulk-process - Generate execution plan
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      action,
      csvData,
      csvString,
      promptTemplate,
      model,
      chatId,
      mode,
      userId,
      isAuthenticated,
    } = body

    // Parse CSV if string provided
    let parsedData: CsvRow[] = csvData
    if (!parsedData && csvString) {
      try {
        parsedData = parseCSV(csvString)
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error occurred"
        return NextResponse.json(
          { error: `CSV parsing failed: ${message}` },
          { status: 400 }
        )
      }
    }

    if (!parsedData && body.csvUrl) {
      try {
        const response = await fetch(body.csvUrl)
        if (!response.ok) {
          throw new Error(`Failed to download CSV (${response.status})`)
        }
        const csvText = await response.text()
        parsedData = parseCSV(csvText)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to download CSV"
        return NextResponse.json(
          { error: message },
          { status: 400 }
        )
      }
    }

    if (!parsedData || parsedData.length === 0) {
      return NextResponse.json({ error: "No CSV data provided" }, { status: 400 })
    }

    if (!promptTemplate) {
      return NextResponse.json({ error: "Prompt template required" }, { status: 400 })
    }

    if (!model) {
      return NextResponse.json({ error: "Model selection required" }, { status: 400 })
    }

    const supabase = (await validateUserIdentity(
      userId,
      Boolean(isAuthenticated),
      req
    )) as SupabaseClientType | null

    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase is not configured" },
        { status: 500 }
      )
    }

    const effectiveUserId = isTestAuthBypass(req)
      ? resolveBypassUserId(userId)
      : userId ?? (await supabase.auth.getUser()).data.user?.id

    if (!effectiveUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Action: plan - Generate execution plan
    if (action === "plan") {
      const plan = generateExecutionPlan(parsedData, promptTemplate, model)

      return NextResponse.json({
        success: true,
        plan,
      })
    }

    // Action: execute - Process CSV rows
    if (action === "execute") {
      if (!chatId) {
        return NextResponse.json({ error: "Chat ID required" }, { status: 400 })
      }

      // Get user's API key if they have one
      const provider = getProviderForModel(model)
      const apiKey =
        (await getEffectiveApiKey(effectiveUserId, provider as ProviderWithoutOllama)) || undefined

      // Process the CSV
      const result = await processBulkCSV({
        csvData: parsedData,
        promptTemplate,
        model,
        userId: effectiveUserId,
        chatId,
        supabase,
        apiKey,
        mode: mode || "full",
      })

      // Convert results to CSV
      const outputCSV = resultsToCSV(parsedData, result.results)

      return NextResponse.json({
        success: result.success,
        result,
        outputCSV,
      })
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (error: unknown) {
    console.error("Bulk process error:", error)
    const message = error instanceof Error ? error.message : "Bulk processing failed"
    return NextResponse.json(
      { error: message },
      { status: 500 }
    )
  }
}

// GET /api/bulk-process - Check bulk processing status (placeholder for future job queue)
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId")

  if (!jobId) {
    return NextResponse.json({ error: "Job ID required" }, { status: 400 })
  }

  // TODO: Implement job queue system for long-running bulk processes
  // For now, return a placeholder response
  return NextResponse.json({
    jobId,
    status: "not_implemented",
    message: "Job queue system not yet implemented. Use synchronous processing for now.",
  })
}


