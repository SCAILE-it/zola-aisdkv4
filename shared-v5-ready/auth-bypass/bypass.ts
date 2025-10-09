import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "../../app/types/database.types"

const BYPASS_TOKEN = process.env.TEST_AUTH_BYPASS_TOKEN ?? null
const BYPASS_USER_ID = process.env.TEST_AUTH_BYPASS_USER_ID ?? null

export type TestAuthBypassContext = {
  isBypass: boolean
  userId: string | null
}

export function isTestAuthBypass(request?: Request | null): boolean {
  if (!BYPASS_TOKEN) {
    return false
  }

  if (!request) {
    return false
  }

  const headerToken = request.headers.get("x-test-auth-token")
  if (!headerToken) {
    return false
  }

  return headerToken === BYPASS_TOKEN
}

export function resolveBypassUserId(userId?: string | null): string | null {
  const candidate = BYPASS_USER_ID?.trim() || userId?.trim() || null
  if (!candidate || candidate.length === 0) {
    return null
  }
  return candidate
}

export async function ensureBypassUserExists(
  supabase: SupabaseClient<Database>,
  userId: string
) {
  if (!supabase || !userId) {
    return
  }

  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle()

  if (error) {
    console.error("Failed to fetch bypass user", error)
    return
  }

  if (data?.id === userId) {
    return
  }

  const insertPayload: Database["public"]["Tables"]["users"]["Insert"] = {
    id: userId,
    email: `${userId}@bypass.test`,
    anonymous: false,
    message_count: 0,
    premium: false,
    created_at: new Date().toISOString(),
  }

  const { error: insertError } = await supabase
    .from("users")
    .upsert(insertPayload, { onConflict: "id" })

  if (insertError) {
    console.error("Failed to create bypass test user", insertError)
  }
}


