import type { Attachment } from "../lib/message-utils"
import {
  DownloadSimple,
  FileCsv,
  FilePdf,
  FileText,
  FileXls,
  ImageSquare,
  Paperclip,
} from "@phosphor-icons/react"
import Link from "next/link"

type AttachmentPreviewListProps = {
  attachments?: Attachment[]
}

export function AttachmentPreviewList({ attachments }: AttachmentPreviewListProps) {
  if (!attachments?.length) {
    return null
  }

  return (
    <div className="mb-2 flex w-full max-w-3xl flex-col gap-2">
      {attachments.map((attachment, index) => (
        <AttachmentRow
          key={`${attachment?.name ?? attachment?.url ?? index}`}
          attachment={attachment}
        />
      ))}
    </div>
  )
}

function AttachmentRow({ attachment }: { attachment: Attachment }) {
  const info = resolveAttachmentMeta(attachment)

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/80 px-3 py-2 text-sm shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <info.Icon className="size-4" weight="bold" />
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {info.displayName}
          </p>
          <p className="truncate text-xs text-muted-foreground">{info.subtitle}</p>
        </div>
      </div>
      {info.url ? (
        <Link
          href={info.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground transition hover:border-primary/60 hover:text-primary"
        >
          <DownloadSimple className="size-3.5" weight="bold" />
          Open
        </Link>
      ) : (
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          Uploading…
        </span>
      )}
    </div>
  )
}

function resolveAttachmentMeta(attachment: Attachment) {
  const contentType = attachment?.contentType ?? ""
  const name = attachment?.name ?? attachment?.url?.split("/").pop() ?? "Attachment"
  const url = attachment?.url ?? null

  if (contentType.startsWith("image/")) {
    return {
      Icon: ImageSquare,
      subtitle: formatSubtitle("Image", contentType),
      displayName: name,
      url,
    }
  }

  if (contentType === "application/pdf") {
    return {
      Icon: FilePdf,
      subtitle: formatSubtitle("PDF", contentType),
      displayName: name,
      url,
    }
  }

  if (contentType.includes("csv")) {
    return {
      Icon: FileCsv,
      subtitle: formatSubtitle("CSV", contentType),
      displayName: name,
      url,
    }
  }

  if (
    contentType === "application/vnd.ms-excel" ||
    contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return {
      Icon: FileXls,
      subtitle: formatSubtitle("Spreadsheet", contentType),
      displayName: name,
      url,
    }
  }

  if (contentType.startsWith("text/")) {
    return {
      Icon: FileText,
      subtitle: formatSubtitle("Text", contentType),
      displayName: name,
      url,
    }
  }

  return {
    Icon: Paperclip,
    subtitle: contentType ? contentType : "Unknown file type",
    displayName: name,
    url,
  }
}

function formatSubtitle(label: string, type: string | null) {
  if (!type) return label
  if (type === label) return label
  return `${label} • ${type}`
}

