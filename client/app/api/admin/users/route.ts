import { type NextRequest } from "next/server"
import {
  createApiRoute,
  createSuccessResponse,
  emitAuditEvent,
  ApiErrors,
} from "@/lib/api/index"

export const GET = createApiRoute(
  async (_request: NextRequest, context, user) => {
    if (!user) {
      throw ApiErrors.unauthorized()
    }

    // Privileged user listing — emit audit even when the payload is empty/stubbed
    emitAuditEvent({
      userId: user.id,
      action: "admin.users_list",
      resourceType: "admin_users",
      metadata: {
        route: "/api/admin/users",
        requestId: context.requestId,
        resultCount: 0,
      },
    })

    return createSuccessResponse(
      { users: [] },
      undefined,
      context.requestId
    )
  },
  {
    requireAuth: true,
    requireRole: ["admin", "owner"],
  }
)
