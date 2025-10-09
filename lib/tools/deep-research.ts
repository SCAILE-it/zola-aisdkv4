import { tool } from "ai"
import { z } from "zod"
import {
  GoogleGenerativeAI,
  type GenerateContentRequest,
  type GenerativeModel,
  type GoogleSearchRetrievalTool,
  DynamicRetrievalMode,
} from "@google/generative-ai"

const GEMINI_MODEL_RESEARCH = "models/gemini-2.5-pro"
const GEMINI_MODEL_RELEVANCE = "models/gemini-2.5-flash"
const HEAD_TIMEOUT_MS = 5_000
const MAX_OUTPUT_TOKENS = 32_768

type DeepResearchToolOptions = {
  apiKey?: string | null
}

type ConversationMessage = {
  role: "user" | "assistant" | "system"
  content: string
}

type Citation = {
  title: string
  url: string
  description?: string | null
  originalUrl?: string | null
}

type VerifiedCitation = Citation & {
  verified: boolean
  verificationStatus: "valid" | "warning" | "failed"
  verificationDetails: {
    urlAccessible: boolean
    httpStatus: number | null
    contentRelevant: boolean | null
    confidence: number
    issues: string[]
  }
}

type GroundingChunk = {
  web?: {
    uri?: string
    title?: string
    description?: string
    originalUrl?: string
  }
}

type GroundingMetadata = {
  groundingChunks?: GroundingChunk[]
  groundingSupports?: unknown[]
  webSearchQueries?: string[]
}

type UsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
} | null

type CandidateWithMetadata = {
  content?: {
    parts?: Array<{ text?: string | null }>
  }
  groundingMetadata?: GroundingMetadata
  usageMetadata?: UsageMetadata
}

type GenerativeResponse = {
  candidates?: CandidateWithMetadata[]
  text?: () => string | undefined
  usageMetadata?: UsageMetadata
}

type GenerateContentEnvelope = {
  response?: GenerativeResponse
}

type ContentMessage = GenerateContentRequest["contents"][number]

const POSITIVE_DOMAIN_HINTS = [
  "gov",
  ".edu",
  "nytimes.com",
  "wsj.com",
  "forbes.com",
  "bloomberg.com",
  "techcrunch.com",
  "wired.com",
  "theverge.com",
  "harvard.edu",
  "stanford.edu",
]

const NEGATIVE_DOMAIN_HINTS = [
  "blogspot.com",
  "wordpress.com/free",
  "wixsite.com",
  "medium.com/@",
]

const DeepResearchInputSchema = z.object({
  question: z
    .string()
    .min(4)
    .describe(
      "The research question to investigate (e.g., 'State of AI chip supply chain in 2025')."
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Optional business or website context to ground the answer when the user says 'we/our/company'."
    ),
  conversation: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
      })
    )
    .optional()
    .describe(
      "Optional prior conversation messages to provide additional context for the research model."
    ),
})

const UsageMetadataSchema = z
  .object({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
    totalTokenCount: z.number().optional(),
  })
  .nullable()
  .optional()

const CitationSchema = z
  .object({
    title: z.string().optional(),
    url: z.string().optional(),
    description: z.string().nullable().optional(),
    originalUrl: z.string().nullable().optional(),
    verified: z.boolean().optional(),
    verificationStatus: z.enum(["valid", "warning", "failed"]).optional(),
    verificationDetails: z
      .object({
        urlAccessible: z.boolean().optional(),
        httpStatus: z.number().nullable().optional(),
        contentRelevant: z.boolean().nullable().optional(),
        confidence: z.number().optional(),
        issues: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough()

const DeepResearchSuccessSchema = z.object({
  success: z.literal(true),
  answer: z.string().optional(),
  citations: z.array(CitationSchema),
  metadata: z.object({
    model: z.string(),
    groundingSupports: z.number().optional(),
    searchQueries: z.array(z.string()),
    usage: UsageMetadataSchema,
  }),
})

const DeepResearchFailureSchema = z.object({
  success: z.literal(false),
  message: z.string(),
})

const DeepResearchOutputSchema = z.discriminatedUnion("success", [
  DeepResearchSuccessSchema,
  DeepResearchFailureSchema,
])

export const createDeepResearchTool = (
  options: DeepResearchToolOptions = {}
) => {
  return tool({
    description: `Perform a comprehensive deep research workflow with verified citations using Google search grounding.
Use this when the user needs a thorough analysis that goes beyond a single web search.
Ideal for competitive intelligence, market analysis, and multi-part strategic research.`,
    // @ts-expect-error: `inputSchema` is the preferred v5 property; `parameters` remains for backwards compatibility.
    inputSchema: DeepResearchInputSchema,
    parameters: DeepResearchInputSchema,
    // @ts-expect-error: `outputSchema` is part of the v5 tool builder API.
    outputSchema: DeepResearchOutputSchema,
    execute: async ({ question, context, conversation }) => {
      const geminiApiKey = options.apiKey || process.env.GEMINI_API_KEY

      if (!geminiApiKey) {
        return {
          success: false,
          message:
            "Deep research requires a Gemini API key. Please add GEMINI_API_KEY to the environment or connect a Google Generative AI key in settings.",
        }
      }

      try {
        const client = new GoogleGenerativeAI(geminiApiKey)
        const researchModel = client.getGenerativeModel({
          model: GEMINI_MODEL_RESEARCH,
        })
        const relevanceModel = client.getGenerativeModel({
          model: GEMINI_MODEL_RELEVANCE,
        })

        const prompt = buildResearchPrompt(question, context)
        const contents = buildContents(prompt, conversation)

        const response = await researchModel.generateContent(
          createGroundedRequest(contents)
        )

        const envelope = response as GenerateContentEnvelope
        const answer = extractAnswerText(envelope)
        const candidate = extractFirstCandidate(envelope)
        const grounding = candidate?.groundingMetadata ?? {}

        let citations = enrichCitations(extractCitations(grounding))

        if (!citations.length && grounding.webSearchQueries?.length) {
          citations = fallbackCitations(grounding.webSearchQueries)
        }

        const verifiedCitations = await verifyCitations({
          question,
          answer,
          citations,
          relevanceModel,
        })

        return {
          success: true,
          answer,
          citations: verifiedCitations,
          metadata: {
            model: GEMINI_MODEL_RESEARCH,
            groundingSupports:
              grounding.groundingSupports?.length ?? groundingSupportsLength(grounding),
            searchQueries: grounding.webSearchQueries ?? [],
            usage: extractUsageMetadata(envelope.response, candidate),
          },
        }
      } catch (error) {
        console.error("Deep research error:", error)
        return {
          success: false,
          message: `Deep research failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        }
      }
    },
    onError: ({ error }) => ({
      success: false,
      message:
        error instanceof Error
          ? `Deep research failed: ${error.message}`
          : "Deep research encountered an unexpected error.",
    }),
  })
}

function buildContents(
  prompt: string,
  conversation?: ConversationMessage[]
): ContentMessage[] {
  const contents: ContentMessage[] = []

  if (conversation?.length) {
    for (const message of conversation.slice(-6)) {
      contents.push({ role: message.role, parts: [{ text: message.content }] })
    }
  }

  contents.push({ role: "user", parts: [{ text: prompt }] })
  return contents
}

function buildResearchPrompt(question: string, context?: string) {
  const basePrompt = `DEEP RESEARCH TASK:
${question}

RESEARCH METHODOLOGY:
1. Break this question into 3-5 focused sub-questions that cover different aspects.
2. For each sub-question:
   - Use Google Search to find the most current, authoritative information.
   - Analyze multiple sources to identify patterns and consensus.
   - Note any conflicting viewpoints or data.
3. Synthesize all findings into a comprehensive, well-structured answer.
4. Include specific examples, data points, and statistics where relevant.
5. Cite ALL sources with proper attribution.

RESEARCH QUALITY STANDARDS:
- Prioritize recent sources (2023-2025) for current trends.
- Cross-reference multiple authoritative sources.
- Distinguish between facts, opinions, and predictions.
- Acknowledge uncertainties or knowledge gaps.
- Provide actionable insights, not just information.

Begin your deep research now.`

  if (!context) {
    return basePrompt
  }

  return `═══════════════════════════════════════════════════════════
BUSINESS CONTEXT (reference when the user says "we/our/company")
═══════════════════════════════════════════════════════════
${context.trim()}
═══════════════════════════════════════════════════════════

Use the above context when discussing the user's company or product.

${basePrompt}`
}

function extractAnswerText(response: GenerateContentEnvelope): string {
  const textFromResponse = response.response?.text?.()
  if (textFromResponse) {
    return textFromResponse.trim()
  }

  const candidates = response.response?.candidates ?? []
  const parts: string[] = []

  for (const candidate of candidates) {
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string") {
        parts.push(part.text)
      }
    }
  }

  return parts.join("\n\n").trim()
}

function extractFirstCandidate(
  response: GenerateContentEnvelope
): CandidateWithMetadata | undefined {
  if (response.response?.candidates?.length) {
    return response.response.candidates[0]
  }
  return undefined
}

function extractUsageMetadata(
  response: GenerativeResponse | undefined,
  candidate: CandidateWithMetadata | undefined
): UsageMetadata {
  return candidate?.usageMetadata ?? response?.usageMetadata ?? null
}

function createGroundedRequest(contents: ContentMessage[]): GenerateContentRequest {
  return {
    contents,
    tools: [createGoogleSearchTool()],
    generationConfig: {
      temperature: 0.2,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  }
}

function createGoogleSearchTool(): GoogleSearchRetrievalTool {
  return {
    googleSearchRetrieval: {
      dynamicRetrievalConfig: {
        mode: DynamicRetrievalMode.MODE_DYNAMIC,
      },
    },
  }
}

function extractCitations(grounding: GroundingMetadata): Citation[] {
  const chunks = grounding.groundingChunks ?? []
  const citations: Citation[] = []

  for (const chunk of chunks) {
    const web = chunk.web
    if (!web?.uri) continue

    citations.push({
      title: web.title || web.uri,
      url: web.uri,
      description: web.description,
      originalUrl: web.originalUrl,
    })
  }

  return citations
}

function enrichCitations(citations: Citation[]): Citation[] {
  const seen = new Map<string, Citation>()

  for (const citation of citations) {
    const key = normalizeUrl(citation.url)
    if (!seen.has(key)) {
      seen.set(key, citation)
    }
  }

  return Array.from(seen.values())
}

function normalizeUrl(url: string) {
  let normalized = url.trim()
  for (const prefix of ["http://", "https://"]) {
    if (normalized.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length)
      break
    }
  }

  normalized = normalized.split("#", 1)[0]
  normalized = normalized.replace(/\/$/, "")
  return normalized.toLowerCase()
}

function fallbackCitations(queries: string[], limit = 3): Citation[] {
  return queries.slice(0, limit).map((query) => ({
    title: `Search: ${query}`,
    url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  }))
}

async function verifyCitations({
  question,
  answer,
  citations,
  relevanceModel,
}: {
  question: string
  answer: string
  citations: Citation[]
  relevanceModel: GenerativeModel
}): Promise<VerifiedCitation[]> {
  if (!citations.length) {
    return []
  }

  const verifications = citations.map((citation) =>
    verifySingleCitation({ question, answer, citation, relevanceModel })
  )

  return Promise.all(verifications)
}

async function verifySingleCitation({
  question,
  answer,
  citation,
  relevanceModel,
}: {
  question: string
  answer: string
  citation: Citation
  relevanceModel: GenerativeModel
}): Promise<VerifiedCitation> {
  const issues: string[] = []
  let confidence = 100

  const head = await checkUrlHead(citation.url)
  if (!head.ok) {
    issues.push(`HEAD request failed (${head.status ?? "timeout"})`)
    confidence -= 50
  }

  let contentRelevant: boolean | null = null

  if (head.ok) {
    try {
      const relevance = await relevanceCheck({
        question,
        answer,
        citation,
        relevanceModel,
      })
      contentRelevant = relevance.result

      if (relevance.result === false && relevance.reason) {
        issues.push(relevance.reason)
        confidence -= 30
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown relevance check error"
      issues.push(`Relevance check failed: ${message}`)
      confidence -= 10
    }
  }

  confidence += reputationScore(citation.url)
  confidence = Math.max(0, Math.min(100, Math.floor(confidence)))

  const status = !head.ok
    ? "failed"
    : confidence >= 80
      ? "valid"
      : "warning"

  return {
    ...citation,
    verified: status === "valid",
    verificationStatus: status,
    verificationDetails: {
      urlAccessible: head.ok,
      httpStatus: head.status,
      contentRelevant,
      confidence,
      issues,
    },
  }
}

async function checkUrlHead(url: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      cache: "no-store",
    })

    return { ok: response.ok, status: response.status }
  } catch {
    return { ok: false, status: null }
  } finally {
    clearTimeout(timeout)
  }
}

async function relevanceCheck({
  question,
  answer,
  citation,
  relevanceModel,
}: {
  question: string
  answer: string
  citation: Citation
  relevanceModel: GenerativeModel
}): Promise<{ result: boolean | null; reason?: string }> {
  const prompt = `You are a citation verification expert.

ORIGINAL QUESTION:
${question}

EXCERPT FROM ANSWER:
${answer.slice(0, 1000)}...

CITED SOURCE:
Title: ${citation.title}
URL: ${citation.url}
${citation.description ? `Description: ${citation.description}` : ""}

TASK:
Decide whether the cited source appears relevant and credible for the claims above.

Respond with exactly:
- "RELEVANT" or
- "QUESTIONABLE" or
- "IRRELEVANT"

Then on a new line, give a short (≤15 words) reason.`

  const response = await relevanceModel.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 128 },
  })

  const envelope = response as GenerateContentEnvelope
  const raw = extractAnswerText(envelope).trim()
  const [verdictLine, ...rest] = raw.split(/\r?\n/)
  const verdict = verdictLine?.toUpperCase() ?? ""
  const reason = rest[0]?.trim()

  if (verdict.includes("RELEVANT")) {
    return { result: true, reason }
  }

  if (verdict.includes("QUESTIONABLE") || verdict.includes("IRRELEVANT")) {
    return { result: false, reason }
  }

  return { result: null, reason: reason || "Unclear relevance verdict" }
}

function reputationScore(url: string) {
  const lowered = url.toLowerCase()

  if (NEGATIVE_DOMAIN_HINTS.some((domain) => lowered.includes(domain))) {
    return -20
  }

  if (POSITIVE_DOMAIN_HINTS.some((domain) => lowered.includes(domain))) {
    return 10
  }

  return 0
}

function groundingSupportsLength(grounding: GroundingMetadata) {
  const supports = grounding.groundingSupports
  if (Array.isArray(supports)) {
    return supports.length
  }
  return 0
}

export type DeepResearchResult = Awaited<
  ReturnType<ReturnType<typeof createDeepResearchTool>["execute"]>
>


