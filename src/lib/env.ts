import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_TIME_ZONE: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat("ja-JP", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid application time zone.").default("Asia/Tokyo"),
  DATABASE_PATH: z.string().min(1).default("./data/kakeimatch.db"),
  RECEIPT_STORAGE_DIR: z.string().min(1).default("./data/receipts"),
  AUTH_SECRET: z.string().min(32).optional(),
  ACTUAL_SERVER_URL: z.string().url().default("http://localhost:5006"),
  ACTUAL_SERVER_PASSWORD: z.string().optional().transform((value) => value || undefined),
  ACTUAL_CLI_DATA_DIR: z.string().min(1).default("./data/actual-cli"),
});

export const env = envSchema.parse(process.env);
