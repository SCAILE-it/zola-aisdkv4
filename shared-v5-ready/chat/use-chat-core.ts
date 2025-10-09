/**
 * Architecture briefing (v1 handoff):
 *
 * - This hook is the production entry point for the shared v5 chat layer. It wraps
 *   ai-sdk v5 with all app behaviors intact (guest provisioning, rate limits,
 *   Supabase prompt queue, search toggle, suggestions, draft persistence, etc.).
 * - Optimistic user messages now ship `parts` plus `experimental_attachments`, so
 *   downstream renderers can keep file previews visible while uploads/queue jobs
 *   settle.
 * - `pendingQueueJobs` exposes queue status + cancel handlers for the prompt list UI;
 *   pair with `shared-v5-ready/chat/prompt-queue-list.tsx` when wiring the app shell.
 * - Text and attachment rendering lives in `shared-v5-ready/chat/conversation.tsx`
 *   using `getTextContent`/`filePartsToAttachments`, so anything consuming this hook
 *   should rely on `UIMessage.parts` first and treat legacy fields as optional.
 */
import { useChatDraft } from "@/app/hooks/use-chat-draft"
import { toast } from "@/components/ui/toast"
import { getOrCreateGuestUserId } from "@/lib/api"
import { MESSAGE_MAX_LENGTH, SYSTEM_PROMPT_DEFAULT } from "@/lib/config"
import { Attachment } from "@/lib/file-handling"
import { API_ROUTE_CHAT } from "@/lib/routes"
import type { UserProfile } from "@/lib/user/types"
import type { AppMessage } from "../lib/message-utils"
import {
  convertAttachmentsToFileUIParts,
  type FileUIPart,
} from "../lib/message-utils"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

type UseChatCoreProps = {
  initialMessages: AppMessage[]
  draftValue: string
  cacheAndAddMessage: (message: AppMessage) => void
  chatId: string | null
  user: UserProfile | null
  files: File[]
  createOptimisticAttachments: (
    files: File[]
  ) => Array<{ name: string; contentType: string; url: string }>
  setFiles: (files: File[]) => void
  checkLimitsAndNotify: (uid: string) => Promise<boolean>
  cleanupOptimisticAttachments: (attachments?: Array<{ url?: string }>) => void
  ensureChatExists: (uid: string, input: string) => Promise<string | null>
  handleFileUploads: (
    uid: string,
    chatId: string
  ) => Promise<Attachment[] | null>
  selectedModel: string
  clearDraft: () => void
  bumpChat: (chatId: string) => void
}

export interface PendingQueueMessage {
  clientId: string
  queueId?: string
  status: "pending" | "processing"
  content: string
  createdAt: Date
  optimisticAttachments?: ReturnType<
    UseChatCoreProps["createOptimisticAttachments"]
  >
}

const QUEUE_STATUS_POLL_INTERVAL = 1500
const MAX_QUEUE_POLL_FAILURES = 5

type QueueStatusResponse = {
  success: boolean
  queue: Array<{
    id: string
    status: "pending" | "processing" | "completed" | "failed" | "cancelled"
  }>
  error?: string
}

async function postJson<TResponse>(url: string, body: unknown, init?: RequestInit) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    body: JSON.stringify(body),
    ...init,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message = payload?.error || payload?.message || "Request failed"
    throw new Error(message)
  }

  return (await response.json()) as TResponse
}

export function useChatCore({
  initialMessages,
  draftValue,
  cacheAndAddMessage,
  chatId,
  user,
  files,
  createOptimisticAttachments,
  setFiles,
  checkLimitsAndNotify,
  cleanupOptimisticAttachments,
  ensureChatExists,
  handleFileUploads,
  selectedModel,
  clearDraft,
  bumpChat,
}: UseChatCoreProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [hasDialogAuth, setHasDialogAuth] = useState(false)
  const [enableSearch, setEnableSearch] = useState(false)
  const [pendingQueueJobs, setPendingQueueJobs] = useState<PendingQueueMessage[]>([])
  const pendingQueueJobsRef = useRef<PendingQueueMessage[]>([])
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollFailureCountRef = useRef(0)

  const hasSentFirstMessageRef = useRef(false)
  const prevChatIdRef = useRef<string | null>(chatId)
  const isAuthenticated = useMemo(() => !!user?.id, [user?.id])
  const systemPrompt = useMemo(
    () => user?.system_prompt || SYSTEM_PROMPT_DEFAULT,
    [user?.system_prompt]
  )

  const updatePendingQueueJobs = useCallback(
    (updater: (prev: PendingQueueMessage[]) => PendingQueueMessage[]) => {
      setPendingQueueJobs((prev) => {
        const next = updater(prev)
        pendingQueueJobsRef.current = next
        return next
      })
    },
    []
  )

  const searchParams = useSearchParams()
  const prompt = searchParams.get("prompt")

  const handleError = useCallback((error: Error) => {
    console.error("Chat error:", error)
    console.error("Error message:", error.message)
    let errorMsg = error.message || "Something went wrong."

    if (errorMsg === "An error occurred" || errorMsg === "fetch failed") {
      errorMsg = "Something went wrong. Please try again."
    }

    toast({
      title: errorMsg,
      status: "error",
    })
  }, [])

  const chat = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: API_ROUTE_CHAT }),
    onFinish: ({ message }) => {
      if (message) {
        cacheAndAddMessage(message as AppMessage)
      }
    },
    onError: handleError,
  })

  const {
    messages,
    status,
    error,
    stop,
    setMessages,
    sendMessage,
    regenerate,
  } = chat

  const [input, setInput] = useState(draftValue)

  useEffect(() => {
    if (prompt && typeof window !== "undefined") {
      requestAnimationFrame(() => setInput(prompt))
    }
  }, [prompt, setInput])

  if (
    prevChatIdRef.current !== null &&
    chatId === null &&
    messages.length > 0
  ) {
    setMessages([])
  }
  prevChatIdRef.current = chatId

  const clearPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    pollFailureCountRef.current = 0
  }

  useEffect(() => {
    if (!pendingQueueJobs.length) {
      clearPolling()
    }
  }, [pendingQueueJobs.length])

  const submit = useCallback(async () => {
    setIsSubmitting(true)

    const uid = await getOrCreateGuestUserId(user)
    if (!uid) {
      setIsSubmitting(false)
      return
    }

    const optimisticId = `optimistic-${Date.now().toString()}`
    const optimisticAttachments =
      files.length > 0 ? createOptimisticAttachments(files) : []

    const parts: any[] = [{ type: "text", text: input }]
    if (optimisticAttachments.length > 0) {
      for (const attachment of optimisticAttachments) {
        parts.push({
          type: "file",
          name: attachment.name,
          contentType: attachment.contentType,
          url: attachment.url,
        })
      }
    }

    const optimisticMessage: AppMessage = {
      id: optimisticId,
      role: "user",
      parts,
      createdAt: new Date(),
      content: input,
      experimental_attachments:
        optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
    }

    setMessages((prev) => [...prev, optimisticMessage])
    hasSentFirstMessageRef.current = true
    setInput("")

    const queueMessage: PendingQueueMessage = {
      clientId: optimisticId,
      status: "pending",
      content: input,
      createdAt: new Date(),
      optimisticAttachments,
    }
    updatePendingQueueJobs((prev) => [...prev, queueMessage])

    const submittedFiles = [...files]
    setFiles([])

    try {
      const allowed = await checkLimitsAndNotify(uid)
      if (!allowed) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
        cleanupOptimisticAttachments(optimisticAttachments)
        updatePendingQueueJobs((prev) =>
          prev.filter((item) => item.clientId !== optimisticId)
        )
        return
      }

      const currentChatId = await ensureChatExists(uid, input)
      if (!currentChatId) {
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
        cleanupOptimisticAttachments(optimisticAttachments)
        updatePendingQueueJobs((prev) =>
          prev.filter((item) => item.clientId !== optimisticId)
        )
        return
      }

      if (input.length > MESSAGE_MAX_LENGTH) {
        toast({
          title: `The message you submitted was too long, please submit something shorter. (Max ${MESSAGE_MAX_LENGTH} characters)`,
          status: "error",
        })
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
        cleanupOptimisticAttachments(optimisticAttachments)
        updatePendingQueueJobs((prev) =>
          prev.filter((item) => item.clientId !== optimisticId)
        )
        return
      }

      let attachments: Attachment[] | null = []
      if (submittedFiles.length > 0) {
        attachments = await handleFileUploads(uid, currentChatId)
        if (attachments === null) {
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
          cleanupOptimisticAttachments(optimisticAttachments)
          updatePendingQueueJobs((prev) =>
            prev.filter((item) => item.clientId !== optimisticId)
          )
          return
        }
      }

      const enqueueResponse = await postJson<{
        success: boolean
        queue?: { id: string; status: string }
        error?: string
      }>("/api/prompt-queue/enqueue", {
        userId: uid,
        chatId: currentChatId,
        model: selectedModel,
        isAuthenticated,
        systemPrompt,
        enableSearch,
        messages: messages.concat({
          id: optimisticId,
          role: "user",
          content: input,
        }),
        attachments,
      })

      if (!enqueueResponse.success || !enqueueResponse.queue?.id) {
        throw new Error(enqueueResponse.error || "Failed to enqueue prompt")
      }

      updatePendingQueueJobs((prev) =>
        prev.map((item) =>
          item.clientId === optimisticId
            ? {
                ...item,
                queueId: enqueueResponse.queue!.id,
                status:
                  enqueueResponse.queue!.status === "processing"
                    ? "processing"
                    : "pending",
              }
            : item
        )
      )

      if (!pollIntervalRef.current) {
        pollIntervalRef.current = setInterval(async () => {
          try {
            const activeJobs = pendingQueueJobsRef.current
            if (!activeJobs.length) {
              clearPolling()
              return
            }

            const queueIds = activeJobs
              .map((job) => job.queueId)
              .filter((id): id is string => typeof id === "string" && id.length > 0)

            if (!queueIds.length) {
              return
            }

            const statusResponse = await postJson<QueueStatusResponse>(
              "/api/prompt-queue/status",
              {
                userId: uid,
                isAuthenticated,
                queueIds,
              }
            )

            if (!statusResponse.success) {
              throw new Error(statusResponse.error || "Failed to fetch queue status")
            }

            const completed = statusResponse.queue.filter(
              (job) => job.status === "completed"
            )
            const failed = statusResponse.queue.filter(
              (job) => job.status === "failed" || job.status === "cancelled"
            )

            if (completed.length || failed.length) {
              const completedIds = new Set(completed.map((job) => job.id))
              const failedIds = new Set(failed.map((job) => job.id))

              updatePendingQueueJobs((prev) =>
                prev.filter((job) => {
                  if (!job.queueId) return true
                  if (failedIds.has(job.queueId)) {
                    toast({ title: "Queued message failed", status: "error" })
                    return false
                  }
                  if (completedIds.has(job.queueId)) {
                    return false
                  }
                  return true
                })
              )

              if (completed.length) {
                regenerate({
                  body: {
                    chatId: currentChatId,
                    userId: uid,
                    model: selectedModel,
                    isAuthenticated,
                    systemPrompt,
                  },
                })
              }
            }
          } catch (error) {
            pollFailureCountRef.current += 1
            console.error("Failed to poll queue status", error)
            if (pollFailureCountRef.current >= MAX_QUEUE_POLL_FAILURES) {
              clearPolling()
              toast({
                title: "Queue updates paused",
                description: "Stopped polling after repeated failures.",
                status: "warning",
              })
            }
          }
        }, QUEUE_STATUS_POLL_INTERVAL)
      }

      setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
      cleanupOptimisticAttachments(optimisticAttachments)
      cacheAndAddMessage(optimisticMessage)
      clearDraft()
      setInput("")

      if (messages.length > 0) {
        bumpChat(currentChatId)
      }
    } catch (error) {
      console.error("Failed to process queued submit", error)
      setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
      const fileParts =
        optimisticMessage.parts?.filter(
          (p): p is FileUIPart => p.type === "file"
        ) || []
      cleanupOptimisticAttachments(
        fileParts.map((p) => ({
          name: p.filename,
          contentType: p.mediaType,
          url: p.url,
        }))
      )
      updatePendingQueueJobs((prev) =>
        prev.filter((item) => item.clientId !== optimisticId)
      )
      toast({ title: "Failed to queue message", status: "error" })
    } finally {
      setIsSubmitting(false)
    }
  }, [
    user,
    files,
    createOptimisticAttachments,
    input,
    setMessages,
    setFiles,
    checkLimitsAndNotify,
    cleanupOptimisticAttachments,
    ensureChatExists,
    handleFileUploads,
    selectedModel,
    isAuthenticated,
    systemPrompt,
    enableSearch,
    sendMessage,
    cacheAndAddMessage,
    clearDraft,
    messages.length,
    bumpChat,
    setIsSubmitting,
    updatePendingQueueJobs,
    regenerate,
  ])

  const handleSuggestion = useCallback(
    async (suggestion: string) => {
      setIsSubmitting(true)
      const optimisticId = `optimistic-${Date.now().toString()}`
      const optimisticMessage: AppMessage = {
        id: optimisticId,
        role: "user",
        createdAt: new Date(),
        parts: [{ type: "text", text: suggestion }],
        content: suggestion,
      }

      setMessages((prev) => [...prev, optimisticMessage])
      hasSentFirstMessageRef.current = true

      try {
        const uid = await getOrCreateGuestUserId(user)

        if (!uid) {
          setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
          return
        }

        const allowed = await checkLimitsAndNotify(uid)
        if (!allowed) {
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
          return
        }

        const currentChatId = await ensureChatExists(uid, suggestion)

        if (!currentChatId) {
          setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
          return
        }

        const options = {
          body: {
            chatId: currentChatId,
            userId: uid,
            model: selectedModel,
            isAuthenticated,
            systemPrompt: SYSTEM_PROMPT_DEFAULT,
          },
        }

        await sendMessage({ text: suggestion }, { body: options.body })

        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
      } catch {
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId))
        toast({ title: "Failed to send suggestion", status: "error" })
      } finally {
        setIsSubmitting(false)
      }
    }, [
      ensureChatExists,
      selectedModel,
      user,
      sendMessage,
      checkLimitsAndNotify,
      isAuthenticated,
      setMessages,
      setIsSubmitting,
    ]
  )

  const handleReload = useCallback(async () => {
    const uid = await getOrCreateGuestUserId(user)
    if (!uid) {
      return
    }

    const options = {
      body: {
        chatId,
        userId: uid,
        model: selectedModel,
        isAuthenticated,
        systemPrompt: systemPrompt || SYSTEM_PROMPT_DEFAULT,
      },
    }

    regenerate(options)
  }, [user, chatId, selectedModel, isAuthenticated, systemPrompt, regenerate])

  const handleCancelQueuedJob = useCallback(
    async (queueId: string) => {
      updatePendingQueueJobs((prev) =>
        prev.filter((job) => job.queueId !== queueId)
      )

      try {
        await postJson<{ success: boolean; error?: string }>(
          "/api/prompt-queue/cancel",
          {
            queueId,
            userId: user?.id,
            isAuthenticated,
          }
        )
      } catch (error) {
        console.error("Failed to cancel queue job", error)
        toast({ title: "Failed to cancel job", status: "error" })
      }
    },
    [isAuthenticated, updatePendingQueueJobs, user?.id]
  )

  const { setDraftValue } = useChatDraft(chatId)
  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value)
      setDraftValue(value)
    },
    [setInput, setDraftValue]
  )

  return {
    messages,
    input,
    status,
    error,
    regenerate,
    stop,
    setMessages,
    setInput,
    sendMessage,
    isAuthenticated,
    systemPrompt,
    hasSentFirstMessageRef,
    isSubmitting,
    setIsSubmitting,
    hasDialogAuth,
    setHasDialogAuth,
    enableSearch,
    setEnableSearch,
    pendingQueueJobs,
    submit,
    handleSuggestion,
    handleReload,
    handleInputChange,
    handleCancelQueuedJob,
  }
}
