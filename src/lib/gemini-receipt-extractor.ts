import "server-only";
import { GoogleGenAI } from "@google/genai";
import type { ReceiptContentType } from "./receipt-validation";
import {
  RECEIPT_EXTRACTION_PROMPT,
  ReceiptExtractionError,
  receiptExtractionJsonSchema,
  validateReceiptExtraction,
  type ReceiptExtractionResult,
  type ReceiptExtractor,
} from "./receipt-extraction";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_REQUEST_TIMEOUT_MS = 30_000;

type InteractionClient = Pick<GoogleGenAI, "interactions">;

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const namedTimeout = "name" in error && ["TimeoutError", "RequestTimeoutError", "APIConnectionTimeoutError"].includes(String((error as { name?: unknown }).name));
  const abort = "name" in error && (error as { name?: unknown }).name === "AbortError";
  return namedTimeout || abort;
}

export function normalizeGeminiError(error: unknown): ReceiptExtractionError {
  if (error instanceof ReceiptExtractionError) return error;
  if (isTimeoutError(error)) return new ReceiptExtractionError("timeout");
  const status = getErrorStatus(error);
  if (status === 429) return new ReceiptExtractionError("rate_limited");
  if (status !== undefined && status >= 500) return new ReceiptExtractionError("provider_unavailable");
  return new ReceiptExtractionError("provider_unavailable");
}

export class GeminiReceiptExtractor implements ReceiptExtractor {
  private readonly client?: InteractionClient;
  private readonly apiKey?: string;
  readonly model: string;

  constructor(options: { apiKey?: string; model?: string; client?: InteractionClient } = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.client = options.client;
  }

  async extract(input: { imageBytes: Buffer; contentType: ReceiptContentType }): Promise<ReceiptExtractionResult> {
    try {
      if (!this.client && !this.apiKey) throw new ReceiptExtractionError("not_configured");
      const client = this.client ?? new GoogleGenAI({
        apiKey: this.apiKey,
      });
      const interaction = await client.interactions.create({
        model: this.model,
        input: [
          { type: "text", text: RECEIPT_EXTRACTION_PROMPT },
          { type: "image", data: input.imageBytes.toString("base64"), mime_type: input.contentType },
        ],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: receiptExtractionJsonSchema,
        },
        store: false,
      }, {
        timeout_ms: GEMINI_REQUEST_TIMEOUT_MS,
        retries: { strategy: "none" },
      });
      if (!interaction.output_text) throw new ReceiptExtractionError("invalid_response");
      let decoded: unknown;
      try {
        decoded = JSON.parse(interaction.output_text);
      } catch {
        throw new ReceiptExtractionError("invalid_response");
      }
      return validateReceiptExtraction(decoded);
    } catch (error) {
      throw normalizeGeminiError(error);
    }
  }
}

export const geminiReceiptExtractor: ReceiptExtractor = new GeminiReceiptExtractor();
