import {
  parseStatementText,
  type StatementParseResult,
  type StatementProvider,
  MAX_STATEMENT_FILE_BYTES,
} from "../../../src/lib/statement-parser-core";

export * from "../../../src/lib/statement-parser-core";

export async function parseStatementBlob(file: Blob, provider: StatementProvider): Promise<StatementParseResult> {
  const defaultEncoding = provider === "smbc_card" ? "cp932" : "utf-8";
  const empty = (code: StatementParseResult["fatalErrors"][number]["code"]): StatementParseResult => ({
    transactions: [], excludedRows: [], duplicateRowsInFile: 0, totalRows: 0,
    encoding: defaultEncoding, fatalErrors: [{ rowNumber: null, code }], headerSignature: null,
  });
  if (file.size > MAX_STATEMENT_FILE_BYTES) return empty("limit_exceeded");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const encoding = provider === "smbc_card" ? "cp932" : hasBom ? "utf-8-bom" : "utf-8";
  if (bytes.length === 0) return empty("empty_file");
  if (bytes.length > MAX_STATEMENT_FILE_BYTES) return empty("limit_exceeded");
  if (bytes.includes(0)) return empty("invalid_file");
  try {
    const text = new TextDecoder(encoding === "cp932" ? "shift_jis" : "utf-8", { fatal: true })
      .decode(hasBom && encoding !== "cp932" ? bytes.subarray(3) : bytes);
    return parseStatementText(text, provider, encoding, bytes.length);
  } catch {
    return empty("invalid_file");
  }
}
