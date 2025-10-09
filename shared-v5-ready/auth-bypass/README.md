# Auth Bypass Quickstart (Shared v5)

This is the **optional** service-role bypass wired into our shared modules. It lets integration/e2e tests hit protected endpoints in `zola-aisdkv5` without spinning up a browser session.

## When to Use

- Local or CI test harnesses (e.g., `scripts/e2e_bulk_via_chat.py`)
- Playground scripts that need to exercise `/api/chat`, `/api/create-chat`, bulk tools, etc.
- Never for production traffic—guard it behind environment variables.

## Enable It

Set the following env vars for whichever process launches your tests/server:

```bash
TEST_AUTH_BYPASS_TOKEN=test-local-bypass-2025
TEST_AUTH_BYPASS_USER_ID=00000000-0000-0000-0000-000000000000
SUPABASE_SERVICE_ROLE=your-service-role-key
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
```

Then send the matching header on every request that should bypass auth:

```
x-test-auth-token: test-local-bypass-2025
```

## What Happens Under the Hood

- `validateUserIdentity` detects the matching token and returns a Supabase **service-role** client (no cookies required).
- Row level security is bypassed, so foreign keys still enforce that `user_id` exists.
- `validateAndTrackUsage` skips rate-limit and entitlement checks when bypass is active.
- The helper will ensure the `TEST_AUTH_BYPASS_USER_ID` record exists in `public.users`; if the header omits a `userId`, this value is used automatically.

## Minimum Supabase Data

Because we bypass RLS, you must seed the referenced rows yourself:

1. Provide a `TEST_AUTH_BYPASS_USER_ID` (or send a `userId` in the request). The helper upserts the corresponding row in `public.users` if it is missing.
2. Optional: seed accompanying tables (`projects`, etc.) if your tests depend on them.

## Safety Tips

- Keep `TEST_AUTH_BYPASS_TOKEN` secret—rotate it for CI.
- Do **not** set the env var in production.
- If you only need read-only access, prefer the guest Supabase client instead.

With this in place, you can port the v4 E2E scripts over to v5 without diffing its codebase.

