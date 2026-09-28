import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnvConfig } from "@next/env";

async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Sync ID input requires an interactive terminal.");
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
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const { linkActualBudget } = await import("@/lib/actual-budget-mapping");
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const email = (await prompt.question("KakeiMatch user email: ")).trim();
    prompt.close();
    const syncId = await readHidden("Actual Budget Sync ID (input hidden): ");
    await linkActualBudget(email, syncId);
    stdout.write("Actual Budget mapping created.\n");
  } finally {
    prompt.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Mapping creation failed.";
  console.error(`Unable to create Actual Budget mapping: ${message}`);
  process.exitCode = 1;
});
