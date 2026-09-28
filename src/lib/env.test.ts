import { describe, expect, it } from "vitest";
import { envSchema } from "./env";

describe("environment schema", () => {
  it("uses portable defaults for local development", () => {
    expect(envSchema.parse({})).toEqual({
      NODE_ENV: "development",
      APP_URL: "http://localhost:3000",
      DATABASE_PATH: "./data/kakeimatch.db",
      AUTH_SECRET: undefined,
    });
  });

  it("rejects an invalid application URL", () => {
    expect(() => envSchema.parse({ APP_URL: "not-a-url" })).toThrow();
  });
});
