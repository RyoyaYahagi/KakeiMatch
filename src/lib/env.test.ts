import { describe, expect, it } from "vitest";
import { envSchema } from "./env";

describe("environment schema", () => {
  it("uses portable defaults for local development", () => {
    expect(envSchema.parse({})).toEqual({
      NODE_ENV: "development",
      APP_URL: "http://localhost:3000",
      APP_TIME_ZONE: "Asia/Tokyo",
      DATABASE_PATH: "./data/kakeimatch.db",
      AUTH_SECRET: undefined,
      ACTUAL_SERVER_URL: "http://localhost:5006",
      ACTUAL_SERVER_PASSWORD: undefined,
      ACTUAL_CLI_DATA_DIR: "./data/actual-cli",
    });
  });

  it("rejects an invalid application URL", () => {
    expect(() => envSchema.parse({ APP_URL: "not-a-url" })).toThrow();
  });

  it("rejects an invalid application time zone", () => {
    expect(() => envSchema.parse({ APP_TIME_ZONE: "not-a-time-zone" })).toThrow();
  });

  it("validates the Actual server URL and treats an empty password as unset", () => {
    expect(() => envSchema.parse({ ACTUAL_SERVER_URL: "not-a-url" })).toThrow();
    expect(envSchema.parse({ ACTUAL_SERVER_PASSWORD: "" }).ACTUAL_SERVER_PASSWORD).toBeUndefined();
  });
});
