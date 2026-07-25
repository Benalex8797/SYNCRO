import { NextRequest } from 'next/server'
import { createApiRoute, createSuccessResponse } from '@/lib/api'

export const GET = createApiRoute(
  async (request: NextRequest) => {
    return createSuccessResponse({ users: [] })
  },
  {
    requireAuth: true,
    requireRole: ['admin', 'owner'],
  }
)
