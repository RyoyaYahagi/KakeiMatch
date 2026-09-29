import { describe, expect, it } from "vitest";
import { envSchema } from "./env";

describe("environment schema", () => {
  it("uses portable defaults for local development", () => {
    expect(envSchema.parse({})).toEqual({
      NODE_ENV: "development",
      APP_URL: "http://localhost:3000",
      APP_TIME_ZONE: "Asia/Tokyo",
      DATABASE_PATH: "./data/kakeimatch.db",
      RECEIPT_STORAGE_DIR: "./data/receipts",
      ACTUAL_SERVER_URL: "http://localhost:5006",
      ACTUAL_CLI_DATA_DIR: "./data/actual-cli",
      TYPESAFE_API_KEY: undefined,
      TYPESAFE_API_URL: "https://api.typesafe.ai/v1/systemone",
      JEV_MODEL: "jev-latest",
      JEV_CATEGORY_MIN_PROBABILITY: 0.75,
      JEV_CATEGORY_MIN_MARGIN: 0.15,
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

  it("validates TypeSafe configuration and applies category thresholds", () => {
    expect(envSchema.parse({ TYPESAFE_API_KEY: "" })).toMatchObject({
      TYPESAFE_API_KEY: undefined,
      TYPESAFE_API_URL: "https://api.typesafe.ai/v1/systemone",
      JEV_MODEL: "jev-latest",
      JEV_CATEGORY_MIN_PROBABILITY: 0.75,
    });
    expect(() => envSchema.parse({ TYPESAFE_API_URL: "bad" })).toThrow();
    expect(() => envSchema.parse({ JEV_MODEL: "" })).toThrow();
    expect(() => envSchema.parse({ JEV_CATEGORY_MIN_PROBABILITY: "1.1" })).toThrow();
  });
});
