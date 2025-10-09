import { createClient } from "@/lib/supabase/server"
import { createGuestServerClient } from "@/lib/supabase/server-guest"
import { isSupabaseEnabled } from "../supabase/config"
import type { Database } from "@/app/types/database.types"
import {
  ensureBypassUserExists,
  isTestAuthBypass,
  resolveBypassUserId,
} from "../../shared-v5-ready/auth-bypass/bypass"

/**
 * Validates the user's identity
 * @param userId - The ID of the user.
 * @param isAuthenticated - Whether the user is authenticated.
 * @returns The Supabase client.
 */
export async function validateUserIdentity(
  userId: string,
  isAuthenticated: boolean,
  req?: Request
): Promise<import("@/app/types/api.types").SupabaseClientType | null> {
  if (!isSupabaseEnabled) {
    return null
  }

  if (isTestAuthBypass(req)) {
    const resolvedUserId = resolveBypassUserId(userId)
    if (!resolvedUserId) {
      throw new Error(
        "TEST_AUTH_BYPASS_TOKEN detected but no user id provided. Set TEST_AUTH_BYPASS_USER_ID or include userId in the request payload."
      )
    }

    const { createServerClient } = await import("@supabase/ssr")

    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE!,
      {
        cookies: {
          getAll: () => [],
          setAll: () => {},
        },
        auth: {
          persistSession: false,
        },
      }
    )

    await ensureBypassUserExists(supabase, resolvedUserId)

    return supabase
  }

  const supabase = isAuthenticated
    ? await createClient()
    : await createGuestServerClient()

  if (!supabase) {
    throw new Error("Failed to initialize Supabase client")
  }

  if (isAuthenticated) {
    const { data: authData, error: authError } = await supabase.auth.getUser()

    if (authError || !authData?.user?.id) {
      throw new Error("Unable to get authenticated user")
    }

    if (authData.user.id !== userId) {
      throw new Error("User ID does not match authenticated user")
    }
  } else {
    const { data: userRecord, error: userError } = await supabase
      .from("users")
      .select("id")
      .eq("id", userId)
      .eq("anonymous", true)
      .maybeSingle()

    if (userError || !userRecord) {
      throw new Error("Invalid or missing guest user")
    }
  }

  return supabase
}
