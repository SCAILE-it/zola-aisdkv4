import type { UIMessage, ReasoningUIPart, FileUIPart } from "ai"
import type { Attachment } from "./file-handling"

export type { ReasoningUIPart, FileUIPart } from "ai"

export interface DatabaseMessage {
  id: string | number
  chat_id: string
  user_id?: string | null
  role: "system" | "user" | "assistant" | "data"
  content: string | null
  parts: any | null
  experimental_attachments: any | null
  created_at: string
  message_group_id?: string | null
  model?: string | null
}

export interface ToolInvocationPart {
  type: string
  toolCallId: string
  toolName: string
  state:
    | "input-streaming"
    | "input-available"
    | "input-complete"
    | "result"
    | "error"
  input?: unknown
  output?: unknown
  errorText?: string
}

export function convertAttachmentsToFileUIParts(
  attachments: Attachment[]
): FileUIPart[] {
  return attachments.map((attachment) => ({
    type: "file" as const,
    mediaType: attachment.contentType,
    filename: attachment.name,
    url: attachment.url,
  }))
}

export interface AppMessage extends UIMessage {
  createdAt?: Date
  message_group_id?: string
  model?: string
}

export function getTextContent(message: UIMessage): string {
  if (!message.parts || message.parts.length === 0) {
    return ""
  }

  const textParts = message.parts.filter((part: any) => part.type === "text")
  return textParts.map((part: any) => part.text || "").join("")
}

export function getFileParts(message: UIMessage): any[] {
  if (!message.parts || message.parts.length === 0) {
    return []
  }

  return message.parts.filter((part: any) => part.type === "file")
}

export function filePartsToAttachments(
  fileParts: FileUIPart[]
): Attachment[] {
  return fileParts.map((part) => ({
    name: part.filename ?? (part as any).name ?? "file",
    contentType: part.mediaType ?? (part as any).contentType ?? "",
    url: part.url,
    storagePath: (part as any).storagePath ?? undefined,
  }))
}

export function uiMessageToDb(
  message: AppMessage,
  chatId: string
): Omit<DatabaseMessage, "id"> {
  const textContent = getTextContent(message)
  const fileParts = getFileParts(message)

  const experimentalAttachments =
    fileParts.length > 0
      ? fileParts.map((part: any) => ({
          name: part.name || "file",
          contentType: part.contentType || part.mimeType || "",
          url: part.url || "",
          storagePath: part.storagePath || undefined,
        }))
      : null

  return {
    chat_id: chatId,
    role: message.role,
    content: textContent || null,
    parts: message.parts || null,
    experimental_attachments: experimentalAttachments,
    created_at: message.createdAt?.toISOString() || new Date().toISOString(),
    message_group_id: message.message_group_id || null,
    model: message.model || null,
  }
}

export function dbToUiMessage(dbMessage: DatabaseMessage): AppMessage {
  if (dbMessage.parts && Array.isArray(dbMessage.parts)) {
    const textContent = extractTextFromParts(dbMessage.parts)
    return {
      id: String(dbMessage.id),
      role: dbMessage.role as "system" | "user" | "assistant",
      parts: dbMessage.parts,
      createdAt: new Date(dbMessage.created_at),
      message_group_id: dbMessage.message_group_id || undefined,
      model: dbMessage.model || undefined,
      content: textContent,
      experimental_attachments:
        (dbMessage.experimental_attachments as Attachment[] | null) || undefined,
    }
  }

  // Fallback: construct parts from v4 format (content + experimental_attachments)
  const parts: any[] = []

  if (dbMessage.content) {
    parts.push({
      type: "text",
      text: dbMessage.content,
    })
  }

  if (
    dbMessage.experimental_attachments &&
    Array.isArray(dbMessage.experimental_attachments)
  ) {
    for (const attachment of dbMessage.experimental_attachments) {
      parts.push({
        type: "file",
        name: attachment.name || "file",
        contentType: attachment.contentType || "",
        url: attachment.url || "",
      })
    }
  }

  return {
    id: String(dbMessage.id),
    role: dbMessage.role as "system" | "user" | "assistant",
    parts: parts.length > 0 ? parts : [{ type: "text", text: "" }],
    createdAt: new Date(dbMessage.created_at),
    message_group_id: dbMessage.message_group_id || undefined,
    model: dbMessage.model || undefined,
    content: dbMessage.content || (parts[0]?.text ?? ""),
    experimental_attachments:
      (dbMessage.experimental_attachments as Attachment[] | null) || undefined,
  }
}

function extractTextFromParts(parts: any[]): string {
  return parts
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text || "")
    .join("")
}

export function createTextMessage(
  text: string,
  role: "user" | "assistant" = "user"
): UIMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    parts: [{ type: "text", text }],
    content: text,
  }
}
