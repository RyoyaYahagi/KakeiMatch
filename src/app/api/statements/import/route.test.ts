import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn<() => Promise<{ id: string } | null>>(),
  importStatement: vi.fn(),
}));
vi.mock("@/lib/current-user", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/statement-import", () => ({ importStatement: mocks.importStatement, StatementImportError: class extends Error {} }));
import { POST } from "./route";

function request(provider = "paypay", name = "synthetic.csv", type = "text/csv") {
  const form = new FormData();
  form.set("provider", provider);
  form.set("userId", "forged-user-b");
  form.set("file", new File(["synthetic"], name, { type }));
  return new NextRequest("http://localhost/api/statements/import", { method: "POST", body: form });
}

describe("statement upload authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "session-user-a" });
    mocks.importStatement.mockResolvedValue({ totalRows: 1, importedRows: 1, duplicateRows: 0, excludedRows: 0, issues: [] });
  });

  it("rejects unauthenticated uploads before parsing", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.importStatement).not.toHaveBeenCalled();
  });

  it("uses only the session identity", async () => {
    expect((await POST(request())).status).toBe(201);
    expect(mocks.importStatement).toHaveBeenCalledWith(expect.objectContaining({ userId: "session-user-a", provider: "paypay" }));
  });

  it("rejects an unknown provider and a non-CSV filename", async () => {
    expect((await POST(request("unknown"))).status).toBe(400);
    expect((await POST(request("paypay", "statement.xlsx"))).status).toBe(400);
    expect(mocks.importStatement).not.toHaveBeenCalled();
  });
});
