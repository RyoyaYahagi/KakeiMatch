import { z } from 'zod';
import { LOCAL_DATABASE_VERSION, LOCAL_DATA_SCHEMA_VERSION } from '../../../src/lib/local-data';

export const diagnosticFeatureSchema = z.enum(['startup', 'save', 'ai', 'migration', 'backup', 'restore', 'runtime']);
export const diagnosticCodeSchema = z.enum([
  'ok', 'operation_failed', 'storage_unavailable', 'migration_failed', 'future_schema', 'storage_blocked',
  'offline_or_unavailable', 'auth_required', 'quota', 'invalid_ai_response', 'provider_unavailable',
  'rate_limited', 'ai_quota_exceeded', 'actual_write_uncertain', 'actual_apply_failed', 'invalid_input',
  'service_worker_failed',
]);
export const diagnosticEntrySchema = z.strictObject({
  feature: diagnosticFeatureSchema,
  outcome: z.enum(['success', 'failure']),
  code: diagnosticCodeSchema,
  secondsAgo: z.number().int().min(0).max(900),
}).refine(entry => (entry.outcome === 'success') === (entry.code === 'ok'));
export const localDiagnosticReportSchema = z.strictObject({
  format: z.literal('kakeimatch-diagnostics'),
  version: z.literal(1),
  build: z.string().regex(/^(?:[0-9a-f]{7,40}|development)$/),
  localDatabaseVersion: z.number().int().positive(),
  localDataSchemaVersion: z.number().int().positive(),
  backupFormatVersion: z.literal(1),
  network: z.enum(['online', 'offline']),
  entries: z.array(diagnosticEntrySchema).max(40),
});
export type DiagnosticFeature = z.infer<typeof diagnosticFeatureSchema>;
type Entry = Omit<z.infer<typeof diagnosticEntrySchema>, 'secondsAgo'> & { at: number };
const MAX_AGE = 15 * 60 * 1000;
let entries: Entry[] = [];

export function recordLocalDiagnostic(feature: DiagnosticFeature, error?: unknown): void {
  let code: z.infer<typeof diagnosticCodeSchema> = 'ok';
  const failed = arguments.length > 1;
  if (failed) {
    code = 'operation_failed';
    // Never inspect messages, causes, stacks, response bodies or arbitrary object properties.
    // Read only an own data property: getters/proxies are not an error-code source.
    if (error && typeof error === 'object') {
      try {
        const property = Object.getOwnPropertyDescriptor(error, 'code');
        const parsed = diagnosticCodeSchema.safeParse(property?.value);
        if (parsed.success && parsed.data !== 'ok') code = parsed.data;
      } catch { /* Unknown objects remain operation_failed. */ }
    }
  }
  const entry = diagnosticEntrySchema.safeParse({ feature, outcome: failed ? 'failure' : 'success', code, secondsAgo: 0 });
  if (!entry.success) return;
  const now = Date.now();
  entries = [...entries.filter(item => item.at >= now - MAX_AGE), { feature: entry.data.feature, outcome: entry.data.outcome, code: entry.data.code, at: now }].slice(-40);
}

export function getLocalDiagnosticReport(build: string, online: boolean, now = Date.now()) {
  entries = entries.filter(entry => entry.at >= now - MAX_AGE);
  return localDiagnosticReportSchema.parse({
    format: 'kakeimatch-diagnostics', version: 1, build,
    localDatabaseVersion: LOCAL_DATABASE_VERSION, localDataSchemaVersion: LOCAL_DATA_SCHEMA_VERSION,
    // .kmb manifest version, independent of IndexedDB and local-data schema versions.
    backupFormatVersion: 1, network: online ? 'online' : 'offline',
    entries: entries.map(({ at, ...entry }) => ({ ...entry, secondsAgo: Math.max(0, Math.min(900, Math.round((now - at) / 1000))) })),
  });
}

export function clearLocalDiagnostics() { entries = []; }
