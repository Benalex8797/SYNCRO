import { NextRequest } from 'next/server'
import { createApiRoute, createSuccessResponse, validateRequestBody } from '@/lib/api'
import { z } from 'zod'

const adminSettingsSchema = z.object({
  maintenanceMode: z.boolean().optional(),
  enableRegistration: z.boolean().optional(),
  rateLimitThreshold: z.number().int().positive().optional(),
})

export const PUT = createApiRoute(
  async (request: NextRequest) => {
    const body = await validateRequestBody(request, adminSettingsSchema)
    return createSuccessResponse({ updated: true, settings: body })
  },
  {
    requireAuth: true,
    requireRole: ['owner'],
  }
)
