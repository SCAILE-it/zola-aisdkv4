import { tool } from "ai"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { z } from "zod"

const GEMINI_WEB_MODEL = process.env.GEMINI_WEB_SEARCH_MODEL ?? "models/gemini-2.5-pro"
const SEARCH_TIMEOUT_MS = Number(process.env.GEMINI_WEB_SEARCH_TIMEOUT_MS ?? 15_000)
const MAX_RESULTS = Number(process.env.GEMINI_WEB_SEARCH_MAX_RESULTS ?? 6)

const WebSearchInputSchema = z.object({
  query: z
    .string()
    .min(3)
    .describe("The question or topic to search for in order to gather up-to-date information"),
  context: z
    .string()
    .optional()
    .describe(
      "Optional business/user context to bias the search when the user says 'we/our/company'"
    ),
})

const WebSearchResultSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  source: z.string().optional(),
  publishedAt: z.string().optional(),
})

const WebSearchSuccessSchema = z.object({
  success: z.literal(true),
  query: z.string(),
  results: z.array(WebSearchResultSchema),
  searchQueries: z.array(z.string()).optional(),
})

const WebSearchFailureSchema = z.object({
  success: z.literal(false),
  query: z.string(),
  message: z.string(),
})

const WebSearchOutputSchema = z.discriminatedUnion("success", [
  WebSearchSuccessSchema,
  WebSearchFailureSchema,
])

function buildSearchPrompt(query: string, context?: string): string {
  if (!context) {
    return `Search query: ${query}`
  }

  return `Search query: ${query}

Context:
${context}`
}

export const createWebSearchTool = () => {
  return tool({
    description:
      "Perform a real-time web search using Gemini grounding. Returns a handful of recent sources with titles, snippets, and URLs.",
    // @ts-expect-error v5 prefers inputSchema; keep parameters for backwards compatibility
    inputSchema: WebSearchInputSchema,
    parameters: WebSearchInputSchema,
    // @ts-expect-error v5 output schema for structured responses
    outputSchema: WebSearchOutputSchema,
    execute: async ({ query, context }) => {
      const apiKey = process.env.GEMINI_API_KEY
      if (!apiKey) {
        return {
          success: false,
          query,
          message:
            "Web search requires a Gemini API key. Set GEMINI_API_KEY to enable live search.",
        }
      }

      try {
        const client = new GoogleGenerativeAI(apiKey)
        const model = client.getGenerativeModel({
          model: GEMINI_WEB_MODEL,
        })

        const prompt = buildSearchPrompt(query, context)
        const response = await model.generateContent(
          {
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }],
              },
            ],
            tools: [{
              googleSearch: {
                dynamicRetrievalConfig: {
                  dynamicThreshold: 0.8,
                  mode: "MODE_DYNAMIC_HIGH_PRECISION",
                },
              },
            }],
            safetySettings: [],
          },
          {
            timeout: SEARCH_TIMEOUT_MS,
          }
        )

        const candidates = response.response?.candidates ?? []
        const results: Array<z.infer<typeof WebSearchResultSchema>> = []
        const searchQueries = new Set<string>()

        for (const candidate of candidates) {
          const grounding = candidate?.groundingMetadata
          grounding?.webSearchQueries?.forEach((q) => searchQueries.add(q))

          const chunks = grounding?.groundingChunks ?? []
          for (const chunk of chunks.slice(0, MAX_RESULTS)) {
            const web = chunk.web
            if (!web?.uri) continue

            results.push({
              title: web.title ?? undefined,
              url: web.uri ?? undefined,
              snippet: web.description ?? undefined,
              source: web.originalUrl ?? undefined,
            })
          }
        }

        if (!results.length) {
          return {
            success: false,
            query,
            message:
              "No grounded web results returned. Try rephrasing the query or providing more context.",
          }
        }

        return {
          success: true,
          query,
          results,
          searchQueries: Array.from(searchQueries),
        }
      } catch (error) {
        console.error("Gemini web search error", error)
        return {
          success: false,
          query,
          message:
            error instanceof Error
              ? `Web search failed: ${error.message}`
              : "Web search failed due to an unknown error.",
        }
      }
    },
    onError: ({ error, input }) => ({
      success: false,
      query: typeof input?.query === "string" ? input.query : "",
      message:
        error instanceof Error
          ? `Web search encountered an error: ${error.message}`
          : "Web search encountered an unexpected error.",
    }),
  })
}

export type WebSearchResult = z.infer<typeof WebSearchResultSchema>


