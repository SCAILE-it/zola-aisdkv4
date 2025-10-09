"use client"

import { useMemo } from "react"

import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card"
import type { PendingQueueMessage } from "./use-chat-core"

type PromptQueueListProps = {
  jobs: PendingQueueMessage[]
  onCancel: (queueId: string) => void
  className?: string
}

export function PromptQueueList({ jobs, onCancel, className }: PromptQueueListProps) {
  const orderedJobs = useMemo(() => {
    return [...jobs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }, [jobs])

  if (!orderedJobs.length) {
    return null
  }

  const cardClassName = [
    "bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40",
    className,
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <Card className={cardClassName}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
        <CardTitle className="text-sm font-semibold text-foreground">
          Queued Prompts
          <span className="text-muted-foreground ml-2 text-xs font-normal">
            {orderedJobs.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {orderedJobs.map((job) => (
          <QueueItem key={job.queueId ?? job.clientId} job={job} onCancel={onCancel} />
        ))}
      </CardContent>
    </Card>
  )
}

type QueueItemProps = {
  job: PendingQueueMessage
  onCancel: (queueId: string) => void
}

function QueueItem({ job, onCancel }: QueueItemProps) {
  const title = useMemo(() => job.content.trim().slice(0, 80) || "(empty message)", [job.content])
  const timestamp = useMemo(() => formatTimestamp(job.createdAt), [job.createdAt])
  const statusVariant = job.status === "processing" ? "processing" : "pending"
  const canCancel = Boolean(job.queueId) && job.status === "pending"

  return (
    <div className="border-border flex flex-col gap-1 rounded-md border px-3 py-2 text-sm md:flex-row md:items-center md:gap-3">
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={statusVariant} />
          <span className="line-clamp-1 text-foreground" title={job.content}>
            {title}
          </span>
        </div>
        <div className="text-muted-foreground text-xs">Queued {timestamp}</div>
      </div>
      <div className="flex items-center gap-2">
        {canCancel ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => onCancel(job.queueId!)}
          >
            Cancel
          </Button>
        ) : null}
        {job.optimisticAttachments && job.optimisticAttachments.length > 0 ? (
          <Badge variant="outline" className="text-xs">
            {job.optimisticAttachments.length} attachment
            {job.optimisticAttachments.length > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: "pending" | "processing" }) {
  if (status === "processing") {
    return (
      <Badge className="bg-amber-500/15 text-amber-600">
        <span className="mr-1 inline-flex size-2 animate-pulse rounded-full bg-current" />
        Processing
      </Badge>
    )
  }

  return (
    <Badge className="bg-primary/15 text-primary">
      <span className="mr-1 inline-flex size-2 rounded-full bg-current" />
      Queued
    </Badge>
  )
}

function formatTimestamp(date: Date) {
  if (!(date instanceof Date)) return "just now"
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
  } catch (error) {
    console.error("Failed to format timestamp", error)
    return "just now"
  }
}


