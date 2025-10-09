"use client"

import { cn } from "@/lib/utils"
import type { ToolInvocationPart } from "../lib/message-utils"
import {
  CaretDown,
  CheckCircle,
  Code,
  Link,
  Nut,
  Spinner,
  Wrench,
} from "@phosphor-icons/react"
import { AnimatePresence, motion, type Transition } from "framer-motion"
import { useMemo, useState, type ReactNode } from "react"
import { ToolLoadingBar } from "../tool-loading/loading-bar"
import type { ToolLoadingBarProps } from "../tool-loading/loading-bar"

interface ToolInvocationProps {
  toolInvocations: ToolInvocationPart[]
  className?: string
  defaultOpen?: boolean
}

const TRANSITION: Transition = {
  type: "spring",
  duration: 0.2,
  bounce: 0,
}

export function ToolInvocation({
  toolInvocations,
  defaultOpen = false,
}: ToolInvocationProps) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen)

  const toolInvocationsData = Array.isArray(toolInvocations)
    ? toolInvocations
    : [toolInvocations]

  const groupedTools = toolInvocationsData.reduce(
    (acc, item) => {
      const { toolCallId } = item
      if (!acc[toolCallId]) {
        acc[toolCallId] = []
      }
      acc[toolCallId].push(item)
      return acc
    },
    {} as Record<string, ToolInvocationPart[]>
  )

  const uniqueToolIds = Object.keys(groupedTools)
  const isSingleTool = uniqueToolIds.length === 1

  if (isSingleTool) {
    return (
      <SingleToolView
        toolInvocations={toolInvocationsData}
        defaultOpen={defaultOpen}
        className="mb-10"
      />
    )
  }

  return (
    <div className="mb-10">
      <div className="border-border flex flex-col gap-0 overflow-hidden rounded-md border">
        <button
          onClick={(e) => {
            e.preventDefault()
            setIsExpanded(!isExpanded)
          }}
          type="button"
          className="hover:bg-accent flex w-full flex-row items-center rounded-t-md px-3 py-2 transition-colors"
        >
          <div className="flex flex-1 flex-row items-center gap-2 text-left text-base">
            <Nut className="text-muted-foreground size-4" />
            <span className="text-sm">Tools executed</span>
            <div className="bg-secondary text-secondary-foreground rounded-full px-1.5 py-0.5 font-mono text-xs">
              {uniqueToolIds.length}
            </div>
          </div>
          <CaretDown
            className={cn(
              "h-4 w-4 transition-transform",
              isExpanded ? "rotate-180 transform" : ""
            )}
          />
        </button>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={TRANSITION}
              className="overflow-hidden"
            >
              <div className="px-3 pt-3 pb-3">
                <div className="space-y-2">
                  {uniqueToolIds.map((toolId) => {
                    const toolInvocationsForId = groupedTools[toolId]

                    if (!toolInvocationsForId?.length) return null

                    return (
                      <div
                        key={toolId}
                        className="pb-2 last:border-0 last:pb-0"
                      >
                        <SingleToolView
                          toolInvocations={toolInvocationsForId}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

type SingleToolViewProps = {
  toolInvocations: ToolInvocationPart[]
  defaultOpen?: boolean
  className?: string
}

function SingleToolView({
  toolInvocations,
  defaultOpen = false,
  className,
}: SingleToolViewProps) {
  const groupedTools = toolInvocations.reduce(
    (acc, item) => {
      const { toolCallId } = item
      if (!acc[toolCallId]) {
        acc[toolCallId] = []
      }
      acc[toolCallId].push(item)
      return acc
    },
    {} as Record<string, ToolInvocationPart[]>
  )

  const toolsToDisplay = Object.values(groupedTools)
    .map((group) => {
      const resultTool = group.find((item) => item.state === "result")
      const inputComplete = group.find(
        (item) => item.state === "input-complete"
      )
      const inputStreaming = group.find(
        (item) => item.state === "input-streaming"
      )

      return resultTool || inputComplete || inputStreaming
    })
    .filter(Boolean) as ToolInvocationPart[]

  if (toolsToDisplay.length === 0) return null

  if (toolsToDisplay.length === 1) {
    return (
      <SingleToolCard
        toolData={toolsToDisplay[0]}
        defaultOpen={defaultOpen}
        className={className}
      />
    )
  }

  return (
    <div className={className}>
      <div className="space-y-4">
        {toolsToDisplay.map((tool) => (
          <SingleToolCard
            key={tool.toolCallId}
            toolData={tool}
            defaultOpen={defaultOpen}
          />
        ))}
      </div>
    </div>
  )
}

function SingleToolCard({
  toolData,
  defaultOpen = false,
  className,
}: {
  toolData: ToolInvocationPart
  defaultOpen?: boolean
  className?: string
}) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen)
  const { state, toolName, toolCallId, input, output } = toolData
  const isLoading = state === "input-streaming"
  const isCompleted = state === "result"
  const result = isCompleted ? output : undefined
  const args = input

  const { parsedResult, parseError } = useMemo(() => {
    if (!isCompleted || !result) return { parsedResult: null, parseError: null }

    try {
      if (Array.isArray(result))
        return { parsedResult: result, parseError: null }

      if (
        typeof result === "object" &&
        result !== null &&
        "content" in result
      ) {
        const content = (result as any).content
        const textContent = Array.isArray(content)
          ? content.find((item: any) => item.type === "text")
          : null
        if (!textContent?.text) return { parsedResult: null, parseError: null }

        try {
          return {
            parsedResult: JSON.parse(textContent.text),
            parseError: null,
          }
        } catch {
          return { parsedResult: textContent.text, parseError: null }
        }
      }

      return { parsedResult: result, parseError: null }
    } catch {
      return { parsedResult: null, parseError: "Failed to parse result" }
    }
  }, [isCompleted, result])

  const formattedArgs: ReactNode =
    args && typeof args === "object" && args !== null
      ? Object.entries(args as Record<string, any>).map(([key, value]) => (
          <div key={key} className="mb-1">
            <span className="text-muted-foreground font-medium">{key}:</span>{" "}
            <span className="font-mono">
              {typeof value === "object"
                ? value === null
                  ? "null"
                  : Array.isArray(value)
                    ? value.length === 0
                      ? "[]"
                      : JSON.stringify(value)
                    : JSON.stringify(value)
                : String(value)}
            </span>
          </div>
        ))
      : null

  const renderResults = () => {
    if (!parsedResult) return "No result data available"

    if (
      loadingBarProps &&
      typeof parsedResult === "object" &&
      parsedResult !== null &&
      "stage" in (parsedResult as Record<string, unknown>) &&
      Object.keys(parsedResult as Record<string, unknown>).length === 1
    ) {
      return null
    }

    if (Array.isArray(parsedResult) && parsedResult.length > 0) {
      if (
        parsedResult[0] &&
        typeof parsedResult[0] === "object" &&
        "url" in parsedResult[0] &&
        "title" in parsedResult[0]
      ) {
        return (
          <div className="space-y-3">
            {parsedResult.map(
              (
                item: { url: string; title: string; snippet?: string },
                index: number
              ) => (
                <div
                  key={index}
                  className="border-border border-b pb-3 last:border-0 last:pb-0"
                >
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary group flex items-center gap-1 font-medium hover:underline"
                  >
                    {item.title}
                    <Link className="h-3 w-3 opacity-70 transition-opacity group-hover:opacity-100" />
                  </a>
                  <div className="text-muted-foreground mt-1 font-mono text-xs">
                    {item.url}
                  </div>
                  {item.snippet && (
                    <div className="mt-1 line-clamp-2 text-sm">
                      {item.snippet}
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        )
      }

      return (
        <div className="font-mono text-xs">
          <pre className="whitespace-pre-wrap">
            {JSON.stringify(parsedResult, null, 2)}
          </pre>
        </div>
      )
    }

    if (typeof parsedResult === "object" && parsedResult !== null) {
      const resultObj = parsedResult as Record<string, unknown>
      const title = typeof resultObj.title === "string" ? resultObj.title : null
      const htmlUrl =
        typeof resultObj.html_url === "string" ? resultObj.html_url : null

      return (
        <div>
          {title && <div className="mb-2 font-medium">{title}</div>}
          {htmlUrl && (
            <div className="mb-2">
              <a
                href={htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary flex items-center gap-1 hover:underline"
              >
                <span className="font-mono">{htmlUrl}</span>
                <Link className="h-3 w-3 opacity-70" />
              </a>
            </div>
          )}
          <div className="font-mono text-xs">
            <pre className="whitespace-pre-wrap">
              {JSON.stringify(parsedResult, null, 2)}
            </pre>
          </div>
        </div>
      )
    }

    if (typeof parsedResult === "string") {
      return <div className="whitespace-pre-wrap">{parsedResult}</div>
    }

    return "No result data available"
  }

  const loadingBarProps = useMemo(() => {
    if (!parsedResult || typeof parsedResult !== "object") return null

    const stageCandidate = (parsedResult as Record<string, unknown>).stage
    if (!stageCandidate || typeof stageCandidate !== "object") return null

    const stage = stageCandidate as Record<string, any>
    const stageType = stage.type
    if (typeof stageType !== "string") return null

    const baseProps: ToolLoadingBarProps = {
      variant: "running",
      title: stage.toolName ?? toolName,
      description: stage.metadata?.description,
    }

    switch (stageType) {
      case "plan":
        return {
          ...baseProps,
          variant: "preparing",
          title: stage.metadata?.title ?? "Preparing bulk plan",
          description:
            stage.metadata?.description ?? "Review the plan before running the tool.",
          details: stage.estimates
            ? [
                {
                  label: "Estimated time",
                  value: stage.estimates.time,
                },
                {
                  label: "Rows",
                  value: String(stage.estimates.rowsToProcess),
                },
              ]
            : undefined,
        } satisfies ToolLoadingBarProps
      case "executing": {
        const current = Number(stage.progress?.current ?? 0)
        const total = Number(stage.progress?.total ?? 0)
        const percentage = total > 0 ? Math.round((current / total) * 100) : undefined
        return {
          ...baseProps,
          variant: "running",
          progress: {
            current,
            total: total > 0 ? total : undefined,
            percentage,
            label: stage.progress?.label ?? "Processing",
          },
          currentRow: stage.progress?.currentRow,
        } satisfies ToolLoadingBarProps
      }
      case "complete":
        const totalProcessed =
          typeof stage.summary?.totalProcessed === "number"
            ? stage.summary.totalProcessed
            : Number(stage.summary?.totalProcessed ?? 0)
        const successful =
          typeof stage.summary?.successful === "number"
            ? stage.summary.successful
            : Number(stage.summary?.successful ?? 0)
        const failed =
          typeof stage.summary?.failed === "number"
            ? stage.summary.failed
            : Number(stage.summary?.failed ?? 0)
        const totalCostValue =
          typeof stage.summary?.totalCost === "number"
            ? stage.summary.totalCost
            : Number(stage.summary?.totalCost ?? 0)
        const totalCostDisplay = Number.isFinite(totalCostValue)
          ? `$${totalCostValue.toFixed(2)}`
          : String(stage.summary?.totalCost ?? "-")

        return {
          ...baseProps,
          variant: "success",
          description: stage.summary
            ? `Processed ${stage.summary.totalProcessed} rows`
            : stage.metadata?.description,
          details: stage.summary
            ? [
                {
                  label: "Succeeded",
                  value: String(successful),
                },
                {
                  label: "Failed",
                  value: String(failed),
                },
                {
                  label: "Cost",
                  value: totalCostDisplay,
                },
              ]
            : undefined,
          download: stage.downloadUrl
            ? {
                url: stage.downloadUrl,
                label: stage.metadata?.downloadLabel ?? "results",
              }
            : undefined,
        } satisfies ToolLoadingBarProps
      case "error":
        return {
          ...baseProps,
          variant: "error",
          description: stage.metadata?.description ?? "The tool encountered an error.",
          errorDetails: stage.error,
        } satisfies ToolLoadingBarProps
      default:
        return null
    }
  }, [parsedResult, toolName])

  return (
    <div
      className={cn(
        "border-border flex flex-col gap-0 overflow-hidden rounded-md border",
        className
      )}
    >
      <button
        onClick={(e) => {
          e.preventDefault()
          setIsExpanded(!isExpanded)
        }}
        type="button"
        className="hover:bg-accent flex w-full flex-row items-center rounded-t-md px-3 py-2 transition-colors"
      >
        <div className="flex flex-1 flex-row items-center gap-2 text-left text-base">
          <Wrench className="text-muted-foreground size-4" />
          <span className="font-mono text-sm">{toolName}</span>
          <AnimatePresence mode="popLayout" initial={false}>
            {isLoading ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, filter: "blur(2px)" }}
                animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, scale: 0.9, filter: "blur(2px)" }}
                transition={{ duration: 0.15 }}
                key="loading"
              >
                <div className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400">
                  <Spinner className="mr-1 h-3 w-3 animate-spin" />
                  Running
                </div>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, filter: "blur(2px)" }}
                animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, scale: 0.9, filter: "blur(2px)" }}
                transition={{ duration: 0.15 }}
                key="completed"
              >
                <div className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-1.5 py-0.5 text-xs text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-400">
                  <CheckCircle className="mr-1 h-3 w-3" />
                  Completed
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <CaretDown
          className={cn(
            "h-4 w-4 transition-transform",
            isExpanded ? "rotate-180 transform" : ""
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={TRANSITION}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-3 pt-3 pb-3">
              {loadingBarProps ? (
                <ToolLoadingBar {...loadingBarProps} />
              ) : null}
              {args &&
              typeof args === "object" &&
              args !== null &&
              Object.keys(args as object).length > 0 ? (
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium">
                    Arguments
                  </div>
                  <div className="bg-background rounded border p-2 text-sm">
                    {formattedArgs}
                  </div>
                </div>
              ) : null}

              {isCompleted && (
                <div>
                  <div className="text-muted-foreground mb-1 text-xs font-medium">
                    Result
                  </div>
                  <div className="bg-background max-h-60 overflow-auto rounded border p-2 text-sm">
                    {parseError ? (
                      <div className="text-red-500">{parseError}</div>
                    ) : (
                      renderResults()
                    )}
                  </div>
                </div>
              )}

              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <div className="flex items-center">
                  <Code className="mr-1 inline size-3" />
                  Tool Call ID:{" "}
                  <span className="ml-1 font-mono">{toolCallId}</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
