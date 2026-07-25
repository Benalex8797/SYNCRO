import { type NextRequest } from "next/server"
import {
  createAuthenticatedApiRoute,
  createSuccessResponse,
  ApiErrors,
  ApiException,
} from "@/lib/api/index"
import { createClient } from "@/lib/supabase/server"
import { trackError } from "@/lib/telemetry"
import { ErrorCode, HttpStatus } from "@/lib/api/types"

/**
 * Fields that are always server-owned. Clients must not supply these on create.
 * On update, `id` is allowed only as a lookup key and is never written back.
 */
const ALWAYS_PROTECTED = ["user_id", "created_at", "updated_at"] as const
const CREATE_PROTECTED = [...ALWAYS_PROTECTED, "id"] as const

function findPresentFields(
  payload: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  return fields.filter((field) =>
    Object.prototype.hasOwnProperty.call(payload, field)
  )
}

function assertNoProtectedFields(
  payload: Record<string, unknown>,
  fields: readonly string[]
): void {
  const present = findPresentFields(payload, fields)
  if (present.length > 0) {
    throw ApiErrors.validationError(
      `Payload must not include protected fields: ${present.join(", ")}`,
      present[0],
      { protectedFields: present }
    )
  }
}

function omitFields(
  payload: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const sanitized = { ...payload }
  for (const field of fields) {
    delete sanitized[field]
  }
  return sanitized
}

async function resolveConflict(
  existingSubscription: Record<string, unknown>,
  updates: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const existingVersion = Number(existingSubscription.version) || 0
  const updateVersion = Number(updates.version) || 0

  if (existingVersion > updateVersion) {
    return {
      ...updates,
      _conflict: true,
      _serverData: existingSubscription,
    }
  }

  return {
    ...existingSubscription,
    ...updates,
    version: Math.max(existingVersion, updateVersion) + 1,
  }
}

export const POST = createAuthenticatedApiRoute(
  async (request: NextRequest, context, user) => {
    let mutation: { type?: string; payload?: Record<string, unknown> }
    try {
      mutation = await request.json()
    } catch {
      throw ApiErrors.validationError("Invalid JSON body")
    }

    const { type, payload } = mutation

    if (!type || typeof type !== "string") {
      throw ApiErrors.validationError("Mutation type is required", "type")
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw ApiErrors.validationError("Mutation payload is required", "payload")
    }

    const supabase = await createClient()

    try {
      if (type === "create") {
        assertNoProtectedFields(payload, CREATE_PROTECTED)

        const { data, error } = await supabase
          .from("subscriptions")
          .insert({
            ...omitFields(payload, CREATE_PROTECTED),
            // Server-owned — assigned after all client fields
            user_id: user.id,
          })
          .select()
          .single()

        if (error) {
          throw ApiErrors.validationError(error.message)
        }

        return createSuccessResponse(
          { success: true, data },
          HttpStatus.OK,
          context.requestId
        )
      }

      if (type === "update") {
        assertNoProtectedFields(payload, ALWAYS_PROTECTED)

        const id = payload.id
        if (!id || typeof id !== "string") {
          throw ApiErrors.validationError("Subscription id is required", "id")
        }

        // Never write id / ownership / timestamps from the client
        const updatePayload = omitFields(payload, [
          ...ALWAYS_PROTECTED,
          "id",
        ])

        const { data: existing, error: fetchError } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("id", id)
          .eq("user_id", user.id)
          .single()

        if (fetchError && fetchError.code === "PGRST116") {
          throw ApiErrors.notFound("Subscription")
        }

        if (fetchError) {
          throw ApiErrors.validationError(fetchError.message)
        }

        if (
          payload.version != null &&
          existing.version != null &&
          Number(payload.version) < Number(existing.version)
        ) {
          const resolved = await resolveConflict(existing, updatePayload)
          throw new ApiException(
            ErrorCode.CONFLICT,
            "Conflict detected",
            HttpStatus.CONFLICT,
            { conflict: true, resolvedData: resolved }
          )
        }

        const { data, error } = await supabase
          .from("subscriptions")
          .update({
            ...updatePayload,
            version: (Number(existing.version) || 0) + 1,
            user_id: user.id,
          })
          .eq("id", id)
          .eq("user_id", user.id)
          .select()
          .single()

        if (error) {
          throw ApiErrors.validationError(error.message)
        }

        return createSuccessResponse(
          { success: true, data },
          HttpStatus.OK,
          context.requestId
        )
      }

      if (type === "delete") {
        const id = payload.id
        if (!id || typeof id !== "string") {
          throw ApiErrors.validationError("Subscription id is required", "id")
        }

        const { error } = await supabase
          .from("subscriptions")
          .delete()
          .eq("id", id)
          .eq("user_id", user.id)

        if (error) {
          throw ApiErrors.validationError(error.message)
        }

        return createSuccessResponse(
          { success: true },
          HttpStatus.OK,
          context.requestId
        )
      }

      throw ApiErrors.validationError("Unknown mutation type", "type")
    } catch (error) {
      if (error instanceof ApiException) {
        throw error
      }
      trackError(error, "sync", { type, userId: user.id })
      throw ApiErrors.internalError("Internal server error")
    }
  }
)
