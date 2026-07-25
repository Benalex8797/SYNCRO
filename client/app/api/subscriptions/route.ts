import { type NextRequest } from "next/server"
import { HttpStatus } from "@/lib/api/types"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { CommonSchemas, validateRequestBody } from "@/lib/api/validation"
import { ApiErrors, createAuthenticatedApiRoute, createSuccessResponse, RateLimiters } from "@/lib/api/index"

// Validation schemas
const createSubscriptionSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name must be less than 100 characters"),
  category: z.string().min(1, "Category is required"),
  price: z.number().positive("Price must be greater than 0"),
  status: z.enum(["active", "cancelled", "expired"]).default("active"),
  renewsIn: z.number().int().min(0).optional(),
  email: z.string().email().optional(),
})

const getSubscriptionsSchema = CommonSchemas.pagination.extend({
  status: z.enum(["active", "cancelled", "expired"]).optional(),
  category: z.string().optional(),
})

export const GET = createAuthenticatedApiRoute(
  async (request: NextRequest, context, user) => {
    // Validate query parameters
    const url = new URL(request.url)
    const queryParams: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      queryParams[key] = value
    })

    const query = getSubscriptionsSchema.partial().safeParse(queryParams)
    const { page = 1, limit = 20, status = "active", category = "undefined" } = query.success ? query.data : {}

    const supabase = await createClient()
    let queryBuilder = supabase
      .from("subscriptions")
      .select("*", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })

    if (status) {
      queryBuilder = queryBuilder.eq("status", status)
    }

    if (category) {
      queryBuilder = queryBuilder.eq("category", category)
    }

    // Apply pagination
    const from = (page - 1) * limit
    const to = from + limit - 1
    queryBuilder = queryBuilder.range(from, to)

    const { data, error, count } = await queryBuilder

    if (error) {
      throw ApiErrors.internalError(`Failed to fetch subscriptions: ${error.message}`)
    }

    const total = count || 0
    const totalPages = Math.ceil(total / limit)

    return createSuccessResponse(
      {
        items: data || [],
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
      HttpStatus.OK,
      context.requestId
    )
  },
  {
    rateLimit: RateLimiters.standard,
  }
)

export const POST = createAuthenticatedApiRoute(
  async (request: NextRequest, context, user) => {
    // Validate request body
    const body = await validateRequestBody(request, createSubscriptionSchema)

    const supabase = await createClient()
    const { data, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id: user.id,
        name: body.name,
        category: body.category,
        price: body.price,
        status: body.status,
        renews_in: body.renewsIn || 30,
        email: body.email,
      })
      .select()
      .single()

    if (error) {
      throw ApiErrors.internalError(`Failed to create subscription: ${error.message}`)
    }

    return createSuccessResponse(
      { subscription: data },
      HttpStatus.CREATED,
      context.requestId
    )
  },
  {
    rateLimit: RateLimiters.standard,
  }
)
