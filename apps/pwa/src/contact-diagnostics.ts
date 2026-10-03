import { recordLocalDiagnostic, type DiagnosticFeature } from './local-diagnostics';

export type DiagnosticScreen =
  | 'home'
  | 'records'
  | 'statements'
  | 'reconciliation'
  | 'settings'
  | 'contact';

export type DiagnosticAction =
  | 'navigate_home'
  | 'navigate_records'
  | 'navigate_statements'
  | 'navigate_reconciliation'
  | 'navigate_settings'
  | 'receipt_ai_started'
  | 'receipt_save_started'
  | 'statement_import_started'
  | 'reconciliation_run_started'
  | 'open_contact'
  | 'contact_recording_started'
  | 'contact_recording_finished'
  | 'contact_interview_started'
  | 'contact_submit_started';

export type DiagnosticEvent =
  | { type: 'screen_open'; at: number; screen: DiagnosticScreen }
  | { type: 'action'; at: number; screen: DiagnosticScreen; action: DiagnosticAction }
  | { type: 'error'; at: number; screen: DiagnosticScreen; errorCode: SafeDiagnosticErrorCode }
  | { type: 'network'; at: number; online: boolean };

export type SanitizedDiagnosticContext = {
  version: 1;
  currentScreen: DiagnosticScreen;
  network: 'online' | 'offline';
  events: Array<
    | { type: 'screen_open'; secondsAgo: number; screen: DiagnosticScreen }
    | { type: 'action'; secondsAgo: number; screen: DiagnosticScreen; action: DiagnosticAction }
    | { type: 'error'; secondsAgo: number; screen: DiagnosticScreen; errorCode: SafeDiagnosticErrorCode }
    | { type: 'network'; secondsAgo: number; online: boolean }
  >;
};

export type SafeDiagnosticErrorCode =
  | 'storage'
  | 'offline_or_unavailable'
  | 'auth_required'
  | 'quota'
  | 'invalid_flow'
  | 'invalid_image'
  | 'invalid_ai_response'
  | 'invalid_confirmation'
  | 'unavailable'
  | 'already_processing'
  | 'actual_write_uncertain'
  | 'actual_apply_failed'
  | 'invalid_input'
  | 'not_found'
  | 'request_failed'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'ai_quota_exceeded'
  | 'invalid_request'
  | 'temporarily_unavailable'
  | 'issue_submission_failed'
  | 'issue_submission_unknown'
  | 'operation_failed';

const MAX_EVENTS = 40;
const MAX_AGE_MS = 15 * 60 * 1000;
const SUPPORT_ACTIONS = new Set<DiagnosticAction>([
  'open_contact',
  'contact_recording_started',
  'contact_recording_finished',
  'contact_interview_started',
  'contact_submit_started',
]);
const SAFE_ERROR_CODES = new Set<SafeDiagnosticErrorCode>([
  'storage',
  'offline_or_unavailable',
  'auth_required',
  'quota',
  'invalid_flow',
  'invalid_image',
  'invalid_ai_response',
  'invalid_confirmation',
  'unavailable',
  'already_processing',
  'actual_write_uncertain',
  'actual_apply_failed',
  'invalid_input',
  'not_found',
  'request_failed',
  'provider_unavailable',
  'rate_limited',
  'ai_quota_exceeded',
  'invalid_request',
  'temporarily_unavailable',
  'issue_submission_failed',
  'issue_submission_unknown',
  'operation_failed',
]);

let events: DiagnosticEvent[] = [];
let currentScreen: DiagnosticScreen = 'home';

function push(event: DiagnosticEvent) {
  const cutoff = Date.now() - MAX_AGE_MS;
  events = [...events.filter(item => item.at >= cutoff), event].slice(-MAX_EVENTS);
}

export function recordDiagnosticScreen(screen: DiagnosticScreen) {
  currentScreen = screen;
  push({ type: 'screen_open', at: Date.now(), screen });
}

export function recordDiagnosticAction(action: DiagnosticAction, screen: DiagnosticScreen = currentScreen) {
  push({ type: 'action', at: Date.now(), screen, action });
}

export function recordDiagnosticNetwork(online: boolean) {
  push({ type: 'network', at: Date.now(), online });
}

export function safeDiagnosticErrorCode(error: unknown): SafeDiagnosticErrorCode {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code as SafeDiagnosticErrorCode;
    if (SAFE_ERROR_CODES.has(code)) return code;
  }
  if (error instanceof Error && error.name === 'LocalDataStorageError') return 'storage';
  return 'operation_failed';
}

export function recordDiagnosticFailure(error: unknown, screen: DiagnosticScreen = currentScreen) {
  push({ type: 'error', at: Date.now(), screen, errorCode: safeDiagnosticErrorCode(error) });
  const action = [...events].reverse().find(event => event.type === 'action' && event.screen === screen) as Extract<DiagnosticEvent, { type: 'action' }> | undefined;
  const feature: DiagnosticFeature = action?.action === 'receipt_ai_started' ? 'ai' : screen === 'records' || screen === 'statements' || screen === 'reconciliation' ? 'save' : 'runtime';
  recordLocalDiagnostic(feature, error);
}

export function getSanitizedDiagnosticContext(now = Date.now()): SanitizedDiagnosticContext {
  const cutoff = now - MAX_AGE_MS;
  const visible = events.filter(event => event.at >= cutoff && !(
    event.type === 'screen_open' && event.screen === 'contact'
  ) && !(
    event.type === 'action' && SUPPORT_ACTIONS.has(event.action)
  ) && !(
    event.type === 'error' && event.screen === 'contact'
  ));
  const priorScreen = [...visible].reverse().find(event => event.type === 'screen_open') as Extract<DiagnosticEvent, { type: 'screen_open' }> | undefined;
  return {
    version: 1,
    currentScreen: priorScreen?.screen ?? (currentScreen === 'contact' ? 'settings' : currentScreen),
    network: navigator.onLine ? 'online' : 'offline',
    events: visible.slice(-20).map(event => {
      const secondsAgo = Math.max(0, Math.min(900, Math.round((now - event.at) / 1000)));
      if (event.type === 'screen_open') return { type: event.type, secondsAgo, screen: event.screen };
      if (event.type === 'action') return { type: event.type, secondsAgo, screen: event.screen, action: event.action };
      if (event.type === 'error') return { type: event.type, secondsAgo, screen: event.screen, errorCode: event.errorCode };
      return { type: event.type, secondsAgo, online: event.online };
    }),
  };
}

// Test-only helper. The recorder is deliberately memory-only and never persists to IndexedDB/localStorage.
export function resetDiagnosticsForTest() {
  events = [];
  currentScreen = 'home';
}
