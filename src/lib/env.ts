import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_PATH: z.string().min(1).default("./data/kakeimatch.db"),
  AUTH_SECRET: z.string().min(32).optional(),
});

export const env = envSchema.parse(process.env);
