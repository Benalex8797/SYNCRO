import { POST } from "../route"
import { NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"

// Mock the Supabase client
jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(),
}))

describe("Offline Sync API", () => {
  let mockSupabase: any
  const mockUserId = "user-123"

  beforeEach(() => {
    mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: { id: mockUserId } } }),
      },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(),
      update: jest.fn().mockReturnThis(),
    }
    ;(createClient as jest.Mock).mockResolvedValue(mockSupabase)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it("should reject updates containing protected fields: user_id", async () => {
    const request = new NextRequest("http://localhost/api/sync/offline", {
      method: "POST",
      body: JSON.stringify({
        type: "update",
        payload: {
          id: "sub-123",
          user_id: "tampered-user-id",
          name: "Updated Name",
        },
      }),
    })

    const response = await POST(request)
    const json = await response.json()

    expect(response.status).toBe(400)
    expect(json.error).toBe("Cannot update protected fields")
    expect(mockSupabase.update).not.toHaveBeenCalled()
  })

  it("should reject updates containing protected fields: created_at", async () => {
    const request = new NextRequest("http://localhost/api/sync/offline", {
      method: "POST",
      body: JSON.stringify({
        type: "update",
        payload: {
          id: "sub-123",
          created_at: "2026-01-01T00:00:00.000Z",
          name: "Updated Name",
        },
      }),
    })

    const response = await POST(request)
    const json = await response.json()

    expect(response.status).toBe(400)
    expect(json.error).toBe("Cannot update protected fields")
  })

  it("should reject updates containing protected fields: deleted_at", async () => {
    const request = new NextRequest("http://localhost/api/sync/offline", {
      method: "POST",
      body: JSON.stringify({
        type: "update",
        payload: {
          id: "sub-123",
          deleted_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it("should reject updates containing protected fields: status", async () => {
    const request = new NextRequest("http://localhost/api/sync/offline", {
      method: "POST",
      body: JSON.stringify({
        type: "update",
        payload: {
          id: "sub-123",
          status: "cancelled",
        },
      }),
    })

    const response = await POST(request)
    expect(response.status).toBe(400)
  })

  it("should reject version tampering (version artificially high)", async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: { id: "sub-123", version: 5 },
      error: null,
    })

    const request = new NextRequest("http://localhost/api/sync/offline", {
      method: "POST",
      body: JSON.stringify({
        type: "update",
        payload: {
          id: "sub-123",
          version: 999, // Tampered version
          name: "Hacked Subscription",
        },
      }),
    })

    const response = await POST(request)
    const json = await response.json()

    expect(response.status).toBe(400)
    expect(json.error).toBe("Invalid version for update")
    expect(mockSupabase.update).not.toHaveBeenCalled()
  })

  it("should allow valid updates and strip unrecognized fields", async () => {
    mockSupabase.single
      .mockResolvedValueOnce({
        data: { id: "sub-123", version: 5 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: "sub-123", version: 6, name: "Valid Update" },
        error: null,
      }) // update return

    const request = new NextRequest("http://localhost/api/sync/offline", {
      method: "POST",
      body: JSON.stringify({
        type: "update",
        payload: {
          id: "sub-123",
          name: "Valid Update",
          version: 5,
          unknown_field: "should_be_stripped",
        },
      }),
    })

    const response = await POST(request)
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.success).toBe(true)

    // Verify what was sent to update()
    expect(mockSupabase.update).toHaveBeenCalledWith({
      name: "Valid Update",
      version: 6,
    })
  })
})
