import { toast } from "@/components/ui/toast"
import { SupabaseClient } from "@supabase/supabase-js"
import * as fileType from "file-type"
import { DAILY_FILE_UPLOAD_LIMIT } from "./config"
import { createClient } from "./supabase/client"
import { isSupabaseEnabled } from "./supabase/config"
import { recordFileMetadata, uploadFileToBucket } from "@/shared-v5-ready/storage/supabase-storage"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]

export type Attachment = {
  name: string
  contentType: string
  url: string
  storagePath?: string
}

export async function validateFile(
  file: File
): Promise<{ isValid: boolean; error?: string }> {
  if (file.size > MAX_FILE_SIZE) {
    return {
      isValid: false,
      error: `File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`,
    }
  }

  // Check if the file type is in our allowed list
  if (!ALLOWED_FILE_TYPES.includes(file.type)) {
    // Special handling for text-based files that might not have a MIME type
    const textExtensions = ['.txt', '.csv', '.md', '.json']
    const hasTextExtension = textExtensions.some(ext => 
      file.name.toLowerCase().endsWith(ext)
    )
    
    if (!hasTextExtension) {
      return {
        isValid: false,
        error: "File type not supported",
      }
    }
  }

  // For binary files, verify the magic bytes match the extension
  const binaryTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf']
  if (binaryTypes.includes(file.type)) {
    const buffer = await file.arrayBuffer()
    const type = await fileType.fileTypeFromBuffer(
      Buffer.from(buffer.slice(0, 4100))
    )
    
    if (!type || type.mime !== file.type) {
      return {
        isValid: false,
        error: "File content doesn't match its extension",
      }
    }
  }

  return { isValid: true }
}

export function createAttachment(file: File, url: string, storagePath?: string): Attachment {
  return {
    name: file.name,
    contentType: file.type,
    url,
    storagePath,
  }
}

export async function processFiles(
  files: File[],
  chatId: string,
  userId: string
): Promise<Attachment[]> {
  const supabase = isSupabaseEnabled ? createClient() : null
  const attachments: Attachment[] = []

  for (const file of files) {
    const validation = await validateFile(file)
    if (!validation.isValid) {
      console.warn(`File ${file.name} validation failed:`, validation.error)
      toast({
        title: "File validation failed",
        description: validation.error,
        status: "error",
      })
      continue
    }

    try {
      let url: string
      let storagePath: string | undefined

      if (supabase) {
        const pathPrefix = `chats/${chatId}/${userId}`.replace(/\s+/g, "-")

        const uploadResult = await uploadFileToBucket({
          supabase,
          file,
          pathPrefix,
        })

        url = uploadResult.publicUrl
        storagePath = uploadResult.storagePath

        await recordFileMetadata({
          supabase,
          chatId,
          userId,
          fileUrl: url,
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          storagePath,
        })
      } else {
        // Use temporary upload endpoint for testing without Supabase
        const formData = new FormData()
        formData.append('file', file)
        
        const response = await fetch('/api/temp-upload', {
          method: 'POST',
          body: formData,
        })
        
        if (!response.ok) {
          throw new Error('Failed to upload file temporarily')
        }
        
        const { url: tempUrl } = await response.json()
        url = tempUrl
      }

      attachments.push(createAttachment(file, url, storagePath))
    } catch (error) {
      console.error(`Error processing file ${file.name}:`, error)
    }
  }

  return attachments
}

export class FileUploadLimitError extends Error {
  code: string
  constructor(message: string) {
    super(message)
    this.code = "DAILY_FILE_LIMIT_REACHED"
  }
}

export async function checkFileUploadLimit(userId: string) {
  if (!isSupabaseEnabled) return 0

  const supabase = createClient()

  if (!supabase) {
    toast({
      title: "File upload is not supported in this deployment",
      status: "info",
    })
    return 0
  }

  const now = new Date()
  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )

  const { count, error } = await supabase
    .from("chat_attachments")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", startOfToday.toISOString())

  if (error) throw new Error(error.message)
  if (count && count >= DAILY_FILE_UPLOAD_LIMIT) {
    throw new FileUploadLimitError("Daily file upload limit reached.")
  }

  return count
}
