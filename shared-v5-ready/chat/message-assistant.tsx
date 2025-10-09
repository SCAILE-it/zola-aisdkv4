"use client"

import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/prompt-kit/message"
import { useUserPreferences } from "@/lib/user-preference-store/provider"
import { cn } from "@/lib/utils"
import type {
  ToolInvocationPart,
  ReasoningUIPart,
  AppMessage,
} from "../lib/message-utils"
import { ArrowClockwise, Check, Copy } from "@phosphor-icons/react"
import { useCallback, useRef } from "react"
import { getSources } from "./get-sources"
import { QuoteButton } from "./quote-button"
import { Reasoning } from "./reasoning"
import { SearchImages } from "./search-images"
import { SourcesList } from "./sources-list"
import { ToolInvocation } from "./tool-invocation"
import { useAssistantMessageSelection } from "./useAssistantMessageSelection"
import type { WebSearchResult } from "@/lib/tools/web-search"

type MessageAssistantProps = {
  children: string
  isLast?: boolean
  hasScrollAnchor?: boolean
  copied?: boolean
  copyToClipboard?: () => void
  onReload?: () => void
  parts?: AppMessage["parts"]
  status?: "streaming" | "ready" | "submitted" | "error"
  className?: string
  messageId: string
  onQuote?: (text: string, messageId: string) => void
}

export function MessageAssistant({
  children,
  isLast,
  hasScrollAnchor,
  copied,
  copyToClipboard,
  onReload,
  parts,
  status,
  className,
  messageId,
  onQuote,
}: MessageAssistantProps) {
  const { preferences } = useUserPreferences()
  const sources = getSources(parts || [])
  const toolInvocationParts =
    (parts?.filter((part) =>
      part.type?.startsWith("tool-") || part.type === "dynamic-tool"
    ) || []) as ToolInvocationPart[]
  const reasoningParts = parts?.find(
    (part) => part.type === "reasoning"
  ) as ReasoningUIPart | undefined
  const contentNullOrEmpty = children === null || children === ""
  const isLastStreaming = status === "streaming" && isLast
  const searchImageResults =
    parts
      ?.filter((part: any) =>
        part.type?.startsWith("tool-") &&
        part.state === "result" &&
        part.toolName === "imageSearch" &&
        part.output?.content?.[0]?.type === "images"
      )
      .flatMap((part: any) => part.output?.content?.[0]?.results ?? []) ?? []

const webSearchResults: WebSearchResult[] =
  parts
    ?.filter(
      (part: any) =>
        part.type?.startsWith("tool-") &&
        part.state === "result" &&
        part.toolName === "web_search"
    )
    .flatMap((part: any) => {
      const payload = Array.isArray(part.output?.content)
        ? part.output?.content.find((item: any) => item.type === "json")?.json
        : null

      if (!payload || payload.success !== true || !Array.isArray(payload.results)) {
        return []
      }

      return payload.results as WebSearchResult[]
    }) ?? []

  const isQuoteEnabled = !preferences.multiModelEnabled
  const messageRef = useRef<HTMLDivElement>(null)
  const { selectionInfo, clearSelection } = useAssistantMessageSelection(
    messageRef,
    isQuoteEnabled
  )
  const handleQuoteBtnClick = useCallback(() => {
    if (selectionInfo && onQuote) {
      onQuote(selectionInfo.text, selectionInfo.messageId)
      clearSelection()
    }
  }, [selectionInfo, onQuote, clearSelection])

  return (
    <Message
      className={cn(
        "group flex w-full max-w-3xl flex-1 items-start gap-4 px-6 pb-2",
        hasScrollAnchor && "min-h-scroll-anchor",
        className
      )}
    >
      <div
        ref={messageRef}
        className={cn(
          "relative flex min-w-full flex-col gap-2",
          isLast && "pb-8"
        )}
        {...(isQuoteEnabled && { "data-message-id": messageId })}
      >
        {reasoningParts && (reasoningParts as any).text && (
          <Reasoning
            reasoningText={(reasoningParts as any).text}
            isStreaming={status === "streaming"}
          />
        )}

        {toolInvocationParts &&
          toolInvocationParts.length > 0 &&
          preferences.showToolInvocations && (
            <ToolInvocation toolInvocations={toolInvocationParts} />
          )}

        {searchImageResults.length > 0 && (
          <SearchImages results={searchImageResults} />
        )}

      {webSearchResults.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Web Results
          </p>
          <ul className="space-y-3">
            {webSearchResults.map((result, index) => (
              <li key={`${result.url ?? "result"}-${index}`} className="space-y-1">
                {result.title ? (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {result.title}
                  </a>
                ) : null}
                {result.snippet ? (
                  <p className="text-sm text-muted-foreground">{result.snippet}</p>
                ) : null}
                <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {result.url ? <span className="truncate font-mono">{result.url}</span> : null}
                  {result.source ? <span>Source: {result.source}</span> : null}
                  {result.publishedAt ? <span>Published: {result.publishedAt}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

        {contentNullOrEmpty ? null : (
          <MessageContent
            className={cn(
              "prose dark:prose-invert relative min-w-full bg-transparent p-0",
              "prose-h1:scroll-m-20 prose-h1:text-2xl prose-h1:font-semibold prose-h2:mt-8 prose-h2:scroll-m-20 prose-h2:text-xl prose-h2:mb-3 prose-h2:font-medium prose-h3:scroll-m-20 prose-h3:text-base prose-h3:font-medium prose-h4:scroll-m-20 prose-h5:scroll-m-20 prose-h6:scroll-m-20 prose-strong:font-medium prose-table:block prose-table:overflow-y-auto"
            )}
            markdown={true}
          >
            {children}
          </MessageContent>
        )}

        {sources && sources.length > 0 && <SourcesList sources={sources} />}

        {Boolean(isLastStreaming || contentNullOrEmpty) ? null : (
          <MessageActions
            className={cn(
              "-ml-2 flex gap-0 opacity-0 transition-opacity group-hover:opacity-100"
            )}
          >
            <MessageAction
              tooltip={copied ? "Copied!" : "Copy text"}
              side="bottom"
            >
              <button
                className="hover:bg-accent/60 text-muted-foreground hover:text-foreground flex size-7.5 items-center justify-center rounded-full bg-transparent transition"
                aria-label="Copy text"
                onClick={copyToClipboard}
                type="button"
              >
                {copied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </button>
            </MessageAction>
            {isLast ? (
              <MessageAction
                tooltip="Regenerate"
                side="bottom"
                delayDuration={0}
              >
                <button
                  className="hover:bg-accent/60 text-muted-foreground hover:text-foreground flex size-7.5 items-center justify-center rounded-full bg-transparent transition"
                  aria-label="Regenerate"
                  onClick={onReload}
                  type="button"
                >
                  <ArrowClockwise className="size-4" />
                </button>
              </MessageAction>
            ) : null}
          </MessageActions>
        )}

        {isQuoteEnabled && selectionInfo && selectionInfo.messageId && (
          <QuoteButton
            mousePosition={selectionInfo.position}
            onQuote={handleQuoteBtnClick}
            messageContainerRef={messageRef}
            onDismiss={clearSelection}
          />
        )}
      </div>
    </Message>
  )
}
