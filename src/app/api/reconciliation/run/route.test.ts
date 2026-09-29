import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/reconciliation-service", () => ({ runReconciliation: mocks.run }));
import { POST } from "./route";

describe("reconciliation run authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.user.mockResolvedValue({ id: "session-user-a" });
    mocks.run.mockResolvedValue({ runId: "run-a" });
  });

  it("rejects unauthenticated requests", async () => {
    mocks.user.mockResolvedValue(null);
    const response = await POST(new NextRequest("http://localhost/api/reconciliation/run", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("uses the session identity despite a forged request body", async () => {
    const response = await POST(new NextRequest("http://localhost/api/reconciliation/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "user-b" }),
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith("session-user-a");
  });
});
