import { type NextRequest } from "next/server"
import { createAuthenticatedApiRoute, createSuccessResponse, RateLimiters, ApiErrors, checkOwnership } from "@/lib/api/index"
import { HttpStatus } from "@/lib/api/types"
import { removeTagFromSubscription } from "@/lib/supabase/tags"
import { createClient } from "@/lib/supabase/server"

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tagId: string }> },
) {
  const { id, tagId } = await params

  return createAuthenticatedApiRoute(
    async (_req, context, user) => {
      const supabase = await createClient()

      // Verify subscription ownership
      const { data: subscription, error: subError } = await supabase
        .from("subscriptions")
        .select("user_id")
        .eq("id", id)
        .single()

      if (subError || !subscription) {
        throw ApiErrors.notFound("Subscription")
      }

      checkOwnership(user.id, subscription.user_id)

      // Proceed with tag removal
      await removeTagFromSubscription(id, tagId)

      return createSuccessResponse({ removed: true }, HttpStatus.OK, context.requestId)
    },
    { rateLimit: RateLimiters.tagMutation },
  )(request)
}
