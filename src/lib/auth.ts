import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "@/db/client";
import { authSchema } from "@/db/schema";
import { env } from "@/lib/env";

export function assertAuthSecret(): string {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  throw new Error("AUTH_SECRET must be set to a secret of at least 32 characters");
}

export function createAuth(options: { allowSignUp?: boolean } = {}) {
  const allowSignUp = options.allowSignUp ?? false;

  return betterAuth({
    appName: "KakeiMatch",
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
  });
}

// Only the server route creates this instance. Next.js can build without a runtime secret.
let publicAuth: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  assertAuthSecret();
  publicAuth ??= createAuth();
  return publicAuth;
}
