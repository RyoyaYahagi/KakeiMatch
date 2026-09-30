import { parseStatementText, type StatementParseResult, type StatementProvider, MAX_STATEMENT_FILE_BYTES } from "./statement-parser-core";
export * from "./statement-parser-core";

export function parseStatement(bytes: Buffer, provider: StatementProvider): StatementParseResult {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const encoding = provider === "smbc_card" ? "cp932" : hasBom ? "utf-8-bom" : "utf-8";
  if (bytes.length === 0) return { transactions: [], excludedRows: [], duplicateRowsInFile: 0, totalRows: 0, encoding, fatalErrors: [{ rowNumber: null, code: "empty_file" }], headerSignature: null };
  if (bytes.length > MAX_STATEMENT_FILE_BYTES) return { transactions: [], excludedRows: [], duplicateRowsInFile: 0, totalRows: 0, encoding, fatalErrors: [{ rowNumber: null, code: "limit_exceeded" }], headerSignature: null };
  if (bytes.includes(0)) return { transactions: [], excludedRows: [], duplicateRowsInFile: 0, totalRows: 0, encoding, fatalErrors: [{ rowNumber: null, code: "invalid_file" }], headerSignature: null };
  try {
    const text = new TextDecoder(encoding === "cp932" ? "shift_jis" : "utf-8", { fatal: true }).decode(hasBom && encoding !== "cp932" ? bytes.subarray(3) : bytes);
    return parseStatementText(text, provider, encoding, bytes.length);
  } catch {
    return { transactions: [], excludedRows: [], duplicateRowsInFile: 0, totalRows: 0, encoding, fatalErrors: [{ rowNumber: null, code: "invalid_file" }], headerSignature: null };
  }
}
