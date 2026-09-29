import { z } from "zod";

const realDate = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});

/** A user's final values, separate from the preserved extraction result. */
export const receiptRegistrationInputSchema = z.object({
  merchant: z.string().trim().min(1).max(200),
  purchasedDate: realDate,
  totalAmountYen: z.number().int().safe().positive(),
  actualAccountId: z.string().min(1).max(128),
}).strict();

export type ReceiptRegistrationInput = z.infer<typeof receiptRegistrationInputSchema>;

export function receiptImportedId(receiptId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receiptId)) {
    throw new Error("Invalid receipt ID.");
  }
  return `kakeimatch:receipt:${receiptId}`;
}
