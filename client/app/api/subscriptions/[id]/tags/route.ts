import { type NextRequest } from "next/server"
import { createAuthenticatedApiRoute, createSuccessResponse, validateRequestBody, RateLimiters, ApiErrors, checkOwnership } from "@/lib/api/index"
import { HttpStatus } from "@/lib/api/types"
import { z } from "zod"
import { addTagToSubscription } from "@/lib/supabase/tags"
import { createClient } from "@/lib/supabase/server"

const bodySchema = z.object({
  tag_id: z.string().uuid(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  return createAuthenticatedApiRoute(
    async (_req, context, user) => {
      const { tag_id } = await validateRequestBody(request, bodySchema)

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

      // Verify tag ownership
      const { data: tag, error: tagError } = await supabase
        .from("subscription_tags")
        .select("user_id")
        .eq("id", tag_id)
        .single()

      if (tagError || !tag) {
        throw ApiErrors.notFound("Tag")
      }

      checkOwnership(user.id, tag.user_id)

      // Proceed with assignment
      await addTagToSubscription(id, tag_id)

      return createSuccessResponse({ assigned: true }, HttpStatus.OK, context.requestId)
    },
    { rateLimit: RateLimiters.tagMutation },
  )(request)
}
