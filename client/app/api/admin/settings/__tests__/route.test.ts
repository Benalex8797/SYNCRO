import { describe, it, expect, vi, beforeEach } from "vitest"
import { PUT } from "../route"
import { requireAuth, requireRole } from "@/lib/api/auth"
import { NextRequest } from "next/server"

vi.mock("@/lib/api/auth", () => ({
  requireAuth: vi.fn(),
  requireRole: vi.fn(),
  createRequestContext: vi.fn().mockReturnValue({ requestId: "test-admin-id" }),
}))

describe("Admin Settings API Route", () => {
  const mockOwner = { id: "user_owner_123", email: "owner@example.com" }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue(mockOwner as any)
    vi.mocked(requireRole).mockResolvedValue(true as any)
  })

  it("should update settings successfully with valid parameters", async () => {
    const validBody = {
      maintenanceMode: true,
      enableRegistration: false,
      rateLimitThreshold: 100,
    }

    const request = new NextRequest("http://localhost/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(validBody),
    })

    const response = await PUT(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.updated).toBe(true)
    expect(body.data.settings).toEqual(validBody)
  })

  it("should support partial settings updates", async () => {
    const partialBody = {
      maintenanceMode: false,
    }

    const request = new NextRequest("http://localhost/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(partialBody),
    })

    const response = await PUT(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.settings).toEqual(partialBody)
  })

  it("should reject setting a negative rateLimitThreshold", async () => {
    const invalidBody = {
      rateLimitThreshold: -10,
    }

    const request = new NextRequest("http://localhost/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(invalidBody),
    })

    const response = await PUT(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.field).toBe("rateLimitThreshold")
  })

  it("should reject setting rateLimitThreshold to 0", async () => {
    const invalidBody = {
      rateLimitThreshold: 0,
    }

    const request = new NextRequest("http://localhost/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(invalidBody),
    })

    const response = await PUT(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  it("should reject invalid data types", async () => {
    const invalidBody = {
      maintenanceMode: "yes", // should be boolean
    }

    const request = new NextRequest("http://localhost/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(invalidBody),
    })

    const response = await PUT(request)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(body.error.field).toBe("maintenanceMode")
  })
})
