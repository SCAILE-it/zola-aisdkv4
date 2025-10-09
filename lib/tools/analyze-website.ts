import { tool } from "ai"
import { z } from "zod"
import { JSDOM } from "jsdom"
import { SupabaseClient } from "@supabase/supabase-js"
import { Database } from "@/app/types/database.types"

// Extract text content from HTML
function extractTextContent(html: string): string {
  try {
    const dom = new JSDOM(html)
    const document = dom.window.document

    // Remove script and style elements
    const scripts = document.querySelectorAll("script, style, noscript")
    scripts.forEach((el) => el.remove())

    // Get text content
    const text = document.body.textContent || ""

    // Clean up whitespace
    return text.replace(/\s+/g, " ").trim().substring(0, 5000) // Limit to 5000 chars
  } catch (error) {
    console.error("Error extracting text:", error)
    return ""
  }
}

// Fetch and analyze website
async function fetchWebsiteContent(url: string) {
  try {
    // Ensure URL has protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GrowthGPT/1.0; +https://growthgpt.ai)",
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const html = await response.text()
    const textContent = extractTextContent(html)

    // Extract domain
    const urlObj = new URL(url)
    const domain = urlObj.hostname.replace(/^www\./, "")

    return {
      domain,
      url,
      content: textContent,
      title: extractTitle(html),
      description: extractMetaDescription(html),
    }
  } catch (error: any) {
    throw new Error(`Failed to fetch website: ${error.message}`)
  }
}

function extractTitle(html: string): string {
  try {
    const dom = new JSDOM(html)
    return dom.window.document.title || ""
  } catch {
    return ""
  }
}

function extractMetaDescription(html: string): string {
  try {
    const dom = new JSDOM(html)
    const meta = dom.window.document.querySelector('meta[name="description"]')
    return meta?.getAttribute("content") || ""
  } catch {
    return ""
  }
}

const AnalyzeWebsiteInputSchema = z.object({
  url: z.string().describe("The website URL to analyze (e.g., 'example.com' or 'https://example.com')"),
  focus: z
    .enum(["general", "gtm_strategy", "tech_stack", "competitive_analysis"])
    .optional()
    .default("general")
    .describe("What aspect to focus the analysis on"),
})

const AnalysisSchema = z.object({
  domain: z.string(),
  title: z.string(),
  description: z.string(),
  content_preview: z.string(),
  analysis_prompt: z.string(),
  focus: z.string(),
  analyzed_at: z.string(),
})

const AnalyzeWebsiteSuccessSchema = z.object({
  success: z.literal(true),
  domain: z.string(),
  title: z.string(),
  description: z.string(),
  analysis: AnalysisSchema,
  message: z.string(),
  analysisPrompt: z.string(),
})

const AnalyzeWebsiteFailureSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  url: z.string().optional(),
})

const AnalyzeWebsiteOutputSchema = z.discriminatedUnion("success", [
  AnalyzeWebsiteSuccessSchema,
  AnalyzeWebsiteFailureSchema,
])

export const createAnalyzeWebsiteTool = (
  supabase: SupabaseClient<Database>,
  userId: string
) => {
  return tool({
    description: `Analyze a website to extract business context: company information, industry, value proposition, business model.
    Use this when the user mentions a website/company and you need to understand their business for GTM analysis.
    Results are stored for future reference in GTM Expert tool.`,
    // @ts-expect-error: Keep `parameters` until all callsites adopt `inputSchema`.
    inputSchema: AnalyzeWebsiteInputSchema,
    parameters: AnalyzeWebsiteInputSchema,
    // @ts-expect-error: `outputSchema` is part of the v5 tool builder API.
    outputSchema: AnalyzeWebsiteOutputSchema,
    execute: async ({ url, focus = "general" }) => {
      try {
        // Fetch website content
        const websiteData = await fetchWebsiteContent(url)

        // Build analysis prompt for AI to extract insights
        const analysisPrompt = `Analyze this website and extract key business information:

Website: ${websiteData.domain}
Title: ${websiteData.title}
Description: ${websiteData.description}

Content Preview (first 5000 chars):
${websiteData.content}

Please extract and structure the following information:
1. Company Name
2. Industry/Vertical
3. Value Proposition (what problem do they solve?)
4. Target Customer (ICP)
5. Business Model (B2B SaaS, B2C, Marketplace, etc.)
6. Key Features/Products
7. GTM Motion (Product-led, Sales-led, Marketing-led)
8. Tech Stack (if visible)
9. Competitive Position
10. Growth Stage indicators

Focus area: ${focus}

Provide a concise, structured analysis suitable for GTM strategy development.`

        // Create structured analysis object
        const analysis = {
          domain: websiteData.domain,
          title: websiteData.title,
          description: websiteData.description,
          content_preview: websiteData.content.substring(0, 500),
          analysis_prompt: analysisPrompt,
          focus,
          analyzed_at: new Date().toISOString(),
        }

        // Store in database for future GTM Expert queries
        if (supabase && userId) {
          try {
            const { error } = await supabase.from("website_contexts").upsert(
              {
                user_id: userId,
                domain: websiteData.domain,
                company_name: websiteData.title || websiteData.domain,
                industry: null, // Will be filled by AI analysis
                value_proposition: websiteData.description || null,
                analysis: analysis as any,
                updated_at: new Date().toISOString(),
              },
              {
                onConflict: "user_id,domain",
              }
            )

            if (error) {
              console.error("Error storing website context:", error)
            }
          } catch (error) {
            console.error("Supabase insert error:", error)
          }
        }

        return {
          success: true,
          domain: websiteData.domain,
          title: websiteData.title,
          description: websiteData.description,
          analysis,
          message: `Website analyzed successfully. Use this analysis prompt to provide insights about ${websiteData.domain}:`,
          analysisPrompt,
        }
      } catch (error: any) {
        console.error("Website analysis error:", error)
        return {
          success: false,
          message: `Failed to analyze website: ${error.message}`,
          url,
        }
      }
    },
    onError: ({ error, input }) => ({
      success: false,
      message:
        error instanceof Error
          ? `Failed to analyze website: ${error.message}`
          : "Website analysis encountered an unexpected error.",
      url: typeof input?.url === "string" ? input.url : undefined,
    }),
  })
}

export type AnalyzeWebsiteResult = Awaited<
  ReturnType<ReturnType<typeof createAnalyzeWebsiteTool>["execute"]>
>


