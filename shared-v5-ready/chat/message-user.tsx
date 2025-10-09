"use client"

import {
  Message as MessageContainer,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/prompt-kit/message"
import { cn } from "@/lib/utils"
import type { AppMessage } from "../lib/message-utils"
import { Check, Copy, Trash } from "@phosphor-icons/react"
import { useState } from "react"
import { AttachmentPreviewList } from "./attachment-preview"

export type MessageUserProps = {
  hasScrollAnchor?: boolean
  attachments?: AppMessage["experimental_attachments"]
  children: string
  copied: boolean
  copyToClipboard: () => void
  onEdit: (id: string, newText: string) => void
  onReload: () => void
  onDelete: (id: string) => void
  id: string
  className?: string
}

export function MessageUser({
  hasScrollAnchor,
  attachments,
  children,
  copied,
  copyToClipboard,
  onDelete,
  id,
  className,
}: MessageUserProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = () => {
    if (isDeleting) return
    setIsDeleting(true)
    try {
      onDelete(id)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <MessageContainer
      className={cn(
        "group flex w-full max-w-3xl flex-col items-end gap-2 px-6 pb-2",
        hasScrollAnchor && "min-h-scroll-anchor",
        className
      )}
    >
      {attachments && attachments.length > 0 && (
        <AttachmentPreviewList attachments={attachments} />
      )}

      <MessageContent
        className="bg-accent prose dark:prose-invert relative max-w-[70%] rounded-3xl px-5 py-2.5"
        markdown={true}
        components={{
          code: ({ children }) => <>{children}</>,
          pre: ({ children }) => <>{children}</>,
          h1: ({ children }) => <p>{children}</p>,
          h2: ({ children }) => <p>{children}</p>,
          h3: ({ children }) => <p>{children}</p>,
          h4: ({ children }) => <p>{children}</p>,
          h5: ({ children }) => <p>{children}</p>,
          h6: ({ children }) => <p>{children}</p>,
          p: ({ children }) => <p>{children}</p>,
          li: ({ children }) => <p>- {children}</p>,
          ul: ({ children }) => <>{children}</>,
          ol: ({ children }) => <>{children}</>,
        }}
      >
        {children}
      </MessageContent>

      <MessageActions className="flex gap-0 opacity-0 transition-opacity group-hover:opacity-100">
        <MessageAction tooltip={copied ? "Copied!" : "Copy text"} side="bottom">
          <button
            className="hover:bg-accent/60 text-muted-foreground hover:text-foreground flex size-7.5 items-center justify-center rounded-full bg-transparent transition"
            aria-label="Copy text"
            onClick={copyToClipboard}
            type="button"
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </MessageAction>
        <MessageAction tooltip="Delete" side="bottom">
          <button
            className="hover:bg-accent/60 text-muted-foreground hover:text-foreground flex size-7.5 items-center justify-center rounded-full bg-transparent transition"
            aria-label="Delete"
            onClick={handleDelete}
            type="button"
            disabled={isDeleting}
          >
            <Trash className="size-4" />
          </button>
        </MessageAction>
      </MessageActions>
    </MessageContainer>
  )
}
