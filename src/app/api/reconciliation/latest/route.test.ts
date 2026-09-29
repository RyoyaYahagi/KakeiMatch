import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), latest: vi.fn() }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/reconciliation-service", () => ({ getLatestReconciliation: mocks.latest }));
import { GET } from "./route";

describe("latest reconciliation authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({ id: "session-user-a" });
    mocks.latest.mockResolvedValue({ runId: "run-a" });
  });

  it("rejects unauthenticated requests", async () => {
    mocks.user.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/reconciliation/latest"));
    expect(response.status).toBe(401);
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("reads only the authenticated user's latest completed snapshot", async () => {
    const response = await GET(new NextRequest("http://localhost/api/reconciliation/latest?userId=user-b"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.latest).toHaveBeenCalledExactlyOnceWith("session-user-a");
  });
});
