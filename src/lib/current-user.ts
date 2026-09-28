import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth, getAuth } from "@/lib/auth";

type Auth = ReturnType<typeof createAuth>;
export type CurrentUser = Auth["$Infer"]["Session"]["user"];

/** Resolve the identity from Better Auth's server-validated session cookie. */
export async function getCurrentUser(requestHeaders?: Headers): Promise<CurrentUser | null> {
  const sessionHeaders = requestHeaders ?? (await headers());
  const session = await getAuth().api.getSession({ headers: sessionHeaders });
  return session?.user ?? null;
}

/** Redirect unauthenticated requests to the login page. */
export async function requireUser(requestHeaders?: Headers): Promise<CurrentUser> {
  const user = await getCurrentUser(requestHeaders);
  if (!user) redirect("/login");
  return user;
}
