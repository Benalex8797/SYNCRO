import { type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  ApiException,
  ApiErrors,
  RateLimiters,
  createAuthenticatedApiRoute,
  createSuccessResponse,
  validateRequestBody,
} from "@/lib/api/index"
import { ErrorCode, HttpStatus } from "@/lib/api/types"
import {
  offlineMutationSchema,
  type OfflineMutation,
  type SyncConflictDetails,
} from "@/lib/sync/offline-mutations"
import { trackError } from "@/lib/telemetry"

// Last-write-wins with version tracking: the newer version becomes the base,
// and the merged row is offered back to the client inside the 409 details.
function resolveConflict(
  existingSubscription: Record<string, unknown>,
  updates: Record<string, unknown>
): SyncConflictDetails {
  const serverVersion = Number(existingSubscription.version) || 0
  const clientVersion = Number(updates.version) || 0

  return {
    conflict: true,
    serverVersion,
    clientVersion,
    serverData: existingSubscription,
    resolvedData: {
      ...existingSubscription,
      ...updates,
      version: Math.max(serverVersion, clientVersion) + 1,
    },
  }
}

export const POST = createAuthenticatedApiRoute(
  async (request: NextRequest, context, user) => {
    const mutation: OfflineMutation = await validateRequestBody(
      request,
      offlineMutationSchema
    )
    const supabase = await createClient()

    try {
      if (mutation.type === "create") {
        const { data, error } = await supabase
          .from("subscriptions")
          .insert({ user_id: user.id, ...mutation.payload })
          .select()
          .single()

        if (error) throw ApiErrors.validationError(error.message)
        return createSuccessResponse(data, HttpStatus.OK, context.requestId)
      }

      if (mutation.type === "update") {
        const { id, version, ...rest } = mutation.payload

        const { data: existing, error: fetchError } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("id", id)
          .eq("user_id", user.id)
          .single()

        if (fetchError && fetchError.code === "PGRST116") {
          throw ApiErrors.notFound("Subscription")
        }
        if (fetchError) throw ApiErrors.validationError(fetchError.message)

        // Optimistic locking: reject stale client versions with the
        // documented conflict contract (see lib/sync/offline-mutations.ts).
        if (version && existing.version && version < existing.version) {
          throw new ApiException(
            ErrorCode.CONFLICT,
            "Conflict detected",
            HttpStatus.CONFLICT,
            resolveConflict(existing, mutation.payload)
          )
        }

        const { data, error } = await supabase
          .from("subscriptions")
          .update({ ...rest, version: (existing.version || 0) + 1 })
          .eq("id", id)
          .eq("user_id", user.id)
          .select()
          .single()

        if (error) throw ApiErrors.validationError(error.message)
        return createSuccessResponse(data, HttpStatus.OK, context.requestId)
      }

      const { error } = await supabase
        .from("subscriptions")
        .delete()
        .eq("id", mutation.payload.id)
        .eq("user_id", user.id)

      if (error) throw ApiErrors.validationError(error.message)
      return createSuccessResponse({ deleted: true }, HttpStatus.OK, context.requestId)
    } catch (error) {
      trackError(error, "database", {
        component: "sync/offline",
        userId: user.id,
        extra: { mutationType: mutation.type, requestId: context.requestId },
      })
      throw error
    }
  },
  {
    rateLimit: RateLimiters.standard,
    idempotent: true,
  }
)
