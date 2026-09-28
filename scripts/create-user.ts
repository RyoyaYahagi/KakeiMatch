import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnvConfig } from "@next/env";

async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Password input requires an interactive terminal.");
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const name = (await prompt.question("Name: ")).trim();
    const email = (await prompt.question("Email: ")).trim();
    prompt.close();
    const password = await readHidden("Password (input hidden): ");

    if (!name || !email || password.length < 12) {
      throw new Error("Name and email are required; password must be at least 12 characters.");
    }

    // This one-off configuration is only used by the local bootstrap command.
    // The public Next.js handler uses the production configuration with signup disabled.
    const { createAuth } = await import("@/lib/auth");
    const auth = createAuth({ allowSignUp: true });
    const result = await auth.api.signUpEmail({
      body: { name, email, password },
    });

    if (!result?.user) throw new Error("Account creation did not return a user.");
    stdout.write(`Created account for ${result.user.email}.\n`);
  } finally {
    prompt.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Account creation failed.";
  console.error(`Unable to create account: ${message}`);
  process.exitCode = 1;
});
