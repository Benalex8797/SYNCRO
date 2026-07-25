import { describe, it, expect, vi, beforeEach } from "vitest"
import { POST } from "../route"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/api/auth"
import { NextRequest } from "next/server"
import { mockSupabaseClient } from "@/lib/test-utils/mocks"

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}))

vi.mock("@/lib/api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/auth")>()
  return {
    ...actual,
    requireAuth: vi.fn(),
    createRequestContext: vi.fn().mockReturnValue({ requestId: "sync-req-1" }),
  }
})

vi.mock("@/lib/telemetry", () => ({
  trackError: vi.fn(),
}))

describe("Offline Sync API Route", () => {
  let supabase: ReturnType<typeof mockSupabaseClient>
  const mockUser = { id: "auth-user-123", email: "user@example.com" }

  beforeEach(() => {
    vi.clearAllMocks()
    supabase = mockSupabaseClient()
    vi.mocked(createClient).mockResolvedValue(supabase as any)
    vi.mocked(requireAuth).mockResolvedValue(mockUser as any)
  })

  function makeRequest(body: unknown) {
    return new NextRequest("http://localhost/api/sync/offline", {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  it("rejects unauthenticated requests with UNAUTHORIZED", async () => {
    const { ApiErrors } = await import("@/lib/api/errors")
    vi.mocked(requireAuth).mockRejectedValue(ApiErrors.unauthorized())

    const response = await POST(
      makeRequest({ type: "create", payload: { name: "Netflix" } })
    )
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe("UNAUTHORIZED")
  })

  it("creates a subscription with the authenticated user_id", async () => {
    supabase.insert.mockReturnThis()
    supabase.select.mockReturnThis()
    supabase.single.mockResolvedValue({
      data: { id: "sub_1", name: "Netflix", user_id: "auth-user-123" },
      error: null,
    })

    const response = await POST(
      makeRequest({
        type: "create",
        payload: { name: "Netflix", price: 15.99 },
      })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(supabase.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Netflix",
        user_id: "auth-user-123",
      })
    )
  })

  it("rejects create payloads that attempt to override user_id", async () => {
    const response = await POST(
      makeRequest({
        type: "create",
        payload: {
          name: "Hijack",
          user_id: "attacker-user-999",
        },
      })
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.message).toContain("user_id")
    expect(supabase.insert).not.toHaveBeenCalled()
  })

  it("rejects create payloads containing created_at or updated_at", async () => {
    const response = await POST(
      makeRequest({
        type: "create",
        payload: {
          name: "Spotify",
          created_at: "2020-01-01T00:00:00Z",
          updated_at: "2020-01-01T00:00:00Z",
        },
      })
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(supabase.insert).not.toHaveBeenCalled()
  })

  it("rejects create payloads that supply a client-owned id", async () => {
    const response = await POST(
      makeRequest({
        type: "create",
        payload: { name: "Disney+", id: "forced-id" },
      })
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.message).toContain("id")
    expect(supabase.insert).not.toHaveBeenCalled()
  })

  it("rejects update payloads that attempt to change user_id", async () => {
    const response = await POST(
      makeRequest({
        type: "update",
        payload: {
          id: "sub_1",
          user_id: "other-user",
          name: "Renamed",
        },
      })
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.message).toContain("user_id")
    expect(supabase.update).not.toHaveBeenCalled()
  })
})
