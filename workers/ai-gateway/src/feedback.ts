import type { AccountD1Database, AccountD1Statement } from './account-auth';
import { removeFeedbackSecrets, sanitizeFeedbackDiagnostics, sanitizeFeedbackMessage } from './feedback-sanitizer';

export type FeedbackKind = 'bug' | 'improvement' | 'question';
export type FeedbackStatus = 'new' | 'reviewing' | 'issue_created' | 'resolved' | 'dismissed';
export type FeedbackAdminInput = { db: AccountD1Database; adminUserId: string; id: string; now: number };
export type FeedbackRow = {
  id: string; created_at: number; updated_at: number; kind: FeedbackKind | null; status: FeedbackStatus;
  message_sanitized: string; ai_summary: string | null; diagnostic_json_sanitized: string | null;
  github_issue_number: number | null; github_issue_url: string | null; resolved_at: number | null; retention_expires_at: number;
  github_issue_state: 'ready' | 'in_progress' | 'unknown' | 'done';
};
export type FeedbackAnalysisInput = { kind: FeedbackKind; message: string; diagnostics: unknown | null };
export type FeedbackIssueInput = { feedbackId: string; kind: FeedbackKind; title: string; body: string; idempotencyMarker: string };
export type FeedbackIssueResult = { number: number; url: string };

type ContactRow = { input_mac: string; state: string; kind: FeedbackKind | null; feedback_id: string | null };

function isKind(value: unknown): value is FeedbackKind { return value === 'bug' || value === 'improvement' || value === 'question'; }
function keyBytes(encoded: string): Uint8Array {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try { binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)); } catch { throw new Error('not_configured'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('not_configured');
  return bytes;
}
function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
function encode(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function encryptOriginal(message: string, encodedKey: string, feedbackId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', asBufferSource(keyBytes(encodedKey)), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv), additionalData: asBufferSource(new TextEncoder().encode(feedbackId)) }, key, asBufferSource(new TextEncoder().encode(message))));
  return `v1.${encode(iv)}.${encode(cipher)}`;
}
async function decryptOriginal(value: string, encodedKey: string, feedbackId: string): Promise<string> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('temporarily_unavailable');
  const decode = (encoded: string) => {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), character => character.charCodeAt(0));
  };
  const key = await crypto.subtle.importKey('raw', asBufferSource(keyBytes(encodedKey)), 'AES-GCM', false, ['decrypt']);
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(decode(parts[1])), additionalData: asBufferSource(new TextEncoder().encode(feedbackId)) }, key, asBufferSource(decode(parts[2]))));
  } catch { throw new Error('not_configured'); }
}
function contactReply(kind: FeedbackKind): string {
  if (kind === 'bug') return '不具合のご連絡を受け付けました。担当者が内容を確認します。';
  if (kind === 'improvement') return '改善のご要望を受け付けました。担当者が内容を確認します。';
  return 'お問い合わせを受け付けました。担当者が内容を確認します。';
}
function id(): string { return crypto.randomUUID(); }
function audit(db: AccountD1Database, adminUserId: string, action: string, targetId: string, now: number): AccountD1Statement {
  return db.prepare('INSERT INTO admin_audit_log(id,admin_user_id,action,target_type,target_id,created_at) VALUES (?,?,?,\'feedback\',?,?)')
    .bind(id(), adminUserId, action, targetId, now);
}
function toApi(row: FeedbackRow) {
  let diagnostics: unknown | null = null;
  if (row.diagnostic_json_sanitized) {
    try { diagnostics = JSON.parse(row.diagnostic_json_sanitized) as unknown; } catch { diagnostics = null; }
  }
  return {
    id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, kind: row.kind, status: row.status,
    message: row.message_sanitized, aiSummary: row.ai_summary, diagnostics,
    githubIssueNumber: row.github_issue_number, githubIssueUrl: row.github_issue_url,
    resolvedAt: row.resolved_at, retentionExpiresAt: row.retention_expires_at,
  };
}
async function getRow(db: AccountD1Database, id: string, now: number): Promise<FeedbackRow | null> {
  return db.prepare('SELECT id,created_at,updated_at,kind,status,message_sanitized,ai_summary,diagnostic_json_sanitized,github_issue_number,github_issue_url,github_issue_state,resolved_at,retention_expires_at FROM feedback_submissions WHERE id=? AND retention_expires_at>?')
    .bind(id, now).first<FeedbackRow>();
}

/** Saves a final user-approved contact message and binds retry behavior to its contents. */
export async function submitContactToInbox(input: {
  db: AccountD1Database; user: string; flowId: string; inputMac: string; kind: FeedbackKind;
  message: string; originalMessage?: string; diagnostic?: unknown; encryptionKey?: string; now: number;
}): Promise<{ feedbackId: string; kind: FeedbackKind; reply: string; issueUrl: null }> {
  const { db, user, flowId, inputMac, kind, now } = input;
  if (!isKind(kind) || !input.message.trim() || input.message.length > 4000 || !input.encryptionKey) throw new Error('not_configured');
  const rawOriginal = input.originalMessage ?? input.message;
  if (!rawOriginal.trim() || rawOriginal.length > 4000) throw new Error('invalid_request');
  const secretSafeOriginal = removeFeedbackSecrets(rawOriginal);
  const messageSanitized = sanitizeFeedbackMessage(input.message);
  const diagnosticJson = sanitizeFeedbackDiagnostics(input.diagnostic);
  if (!messageSanitized.trim()) throw new Error('invalid_request');
  const feedbackId = id();
  const originalEncrypted = await encryptOriginal(secretSafeOriginal, input.encryptionKey, feedbackId);

  await db.prepare("INSERT INTO contact_submissions(user_id,flow_id,input_mac,state,updated_at,kind) VALUES (?,?,?,'ready',?,?) ON CONFLICT(user_id,flow_id) DO NOTHING")
    .bind(user, flowId, inputMac, now, kind).run();
  const read = () => db.prepare('SELECT input_mac,state,kind,feedback_id FROM contact_submissions WHERE user_id=? AND flow_id=?')
    .bind(user, flowId).first<ContactRow>();
  const existing = await read();
  if (!existing || existing.input_mac !== inputMac || existing.kind !== kind) throw new Error('invalid_flow');
  if (existing.state === 'done' && existing.feedback_id) {
    const row = await getRow(db, existing.feedback_id, now);
    if (!row) throw new Error('temporarily_unavailable');
    return { feedbackId: row.id, kind, reply: contactReply(kind), issueUrl: null };
  }
  if (existing.state === 'sending' || existing.state === 'unknown') throw new Error('temporarily_unavailable');
  const claimed = await db.prepare("UPDATE contact_submissions SET state='classifying',updated_at=? WHERE user_id=? AND flow_id=? AND input_mac=? AND (state IN ('ready','failed') OR (state='classifying' AND updated_at<?))")
    .bind(now, user, flowId, inputMac, now - 120).run();
  if (!claimed.success || claimed.meta?.changes !== 1) throw new Error('temporarily_unavailable');

  const statements: AccountD1Statement[] = [
    db.prepare(`INSERT INTO feedback_submissions(id,user_id,created_at,updated_at,kind,status,message_original_encrypted,message_sanitized,diagnostic_json_sanitized,retention_expires_at)
      VALUES (?,?,?,?,?,'new',?,?,?,?)`).bind(feedbackId, user, now, now, kind, originalEncrypted, messageSanitized, diagnosticJson, now + 90 * 24 * 60 * 60),
    db.prepare("UPDATE contact_submissions SET state='done',feedback_id=?,updated_at=? WHERE user_id=? AND flow_id=? AND state='classifying' AND input_mac=?")
      .bind(feedbackId, now, user, flowId, inputMac),
  ];
  let results: Array<{ success: boolean; meta?: { changes?: number } }>;
  try { results = await db.batch<{ success: boolean; meta?: { changes?: number } }>(statements); }
  catch (error) {
    await db.prepare("UPDATE contact_submissions SET state='ready',updated_at=? WHERE user_id=? AND flow_id=? AND state='classifying'")
      .bind(now, user, flowId).run();
    throw error;
  }
  if (!results.every(result => result?.success) || (results[1]?.meta?.changes ?? 0) !== 1) {
    await db.prepare("UPDATE contact_submissions SET state='ready',updated_at=? WHERE user_id=? AND flow_id=? AND state='classifying'")
      .bind(now, user, flowId).run();
    throw new Error('temporarily_unavailable');
  }
  return { feedbackId, kind, reply: contactReply(kind), issueUrl: null };
}

export async function listFeedback(input: { db: AccountD1Database; adminUserId: string; limit?: number; status?: FeedbackStatus; now?: number }) {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (input.status && !['new','reviewing','issue_created','resolved','dismissed'].includes(input.status)) throw new Error('invalid_status');
  const rows = input.status
    ? await input.db.batch<{ success: boolean; results?: FeedbackRow[] }>([input.db.prepare('SELECT id,created_at,updated_at,kind,status,message_sanitized,ai_summary,diagnostic_json_sanitized,github_issue_number,github_issue_url,resolved_at,retention_expires_at FROM feedback_submissions WHERE status=? AND retention_expires_at>? ORDER BY created_at DESC LIMIT ?').bind(input.status, now, limit)])
    : await input.db.batch<{ success: boolean; results?: FeedbackRow[] }>([input.db.prepare('SELECT id,created_at,updated_at,kind,status,message_sanitized,ai_summary,diagnostic_json_sanitized,github_issue_number,github_issue_url,resolved_at,retention_expires_at FROM feedback_submissions WHERE retention_expires_at>? ORDER BY created_at DESC LIMIT ?').bind(now, limit)]);
  return { items: (rows[0]?.results ?? []).map(toApi) };
}

export async function getFeedback(input: FeedbackAdminInput) {
  const row = await getRow(input.db, input.id, input.now);
  if (!row) throw new Error('not_found');
  return toApi(row);
}

export async function revealFeedbackOriginal(input: FeedbackAdminInput & { encryptionKey?: string }) {
  if (!input.encryptionKey) throw new Error('not_configured');
  const row = await input.db.prepare('SELECT message_original_encrypted FROM feedback_submissions WHERE id=? AND retention_expires_at>?').bind(input.id, input.now).first<{ message_original_encrypted: string }>();
  if (!row) throw new Error('not_found');
  const original = await decryptOriginal(row.message_original_encrypted, input.encryptionKey, input.id);
  const result = await input.db.batch<{ success?: boolean; meta?: { changes?: number } }>([
    audit(input.db, input.adminUserId, 'feedback_original_viewed', input.id, input.now),
    input.db.prepare("UPDATE feedback_submissions SET status=CASE WHEN status='new' THEN 'reviewing' ELSE status END,updated_at=? WHERE id=?").bind(input.now, input.id),
  ]);
  if (!result.every((entry: { success?: boolean }) => entry.success)) throw new Error('temporarily_unavailable');
  return { message: original };
}

export async function updateFeedbackStatus(input: FeedbackAdminInput & { status: FeedbackStatus }) {
  if (!['reviewing','resolved','dismissed'].includes(input.status)) throw new Error('invalid_status');
  const result = await input.db.batch<{ success?: boolean; meta?: { changes?: number } }>([
    input.db.prepare("UPDATE feedback_submissions SET status=?,updated_at=?,resolved_at=? WHERE id=?")
      .bind(input.status, input.now, input.status === 'resolved' || input.status === 'dismissed' ? input.now : null, input.id),
    audit(input.db, input.adminUserId, 'feedback_status_updated', input.id, input.now),
  ]);
  if ((result[0] as { meta?: { changes?: number } })?.meta?.changes !== 1) throw new Error('not_found');
  if (!result.every((entry: { success?: boolean }) => entry.success)) throw new Error('temporarily_unavailable');
  return getFeedback(input);
}

export async function deleteFeedback(input: FeedbackAdminInput) {
  const result = await input.db.batch<{ success?: boolean; meta?: { changes?: number } }>([
    audit(input.db, input.adminUserId, 'feedback_deleted', input.id, input.now),
    input.db.prepare('DELETE FROM feedback_submissions WHERE id=?').bind(input.id),
  ]);
  if ((result[1] as { meta?: { changes?: number } })?.meta?.changes !== 1) throw new Error('not_found');
  if (!result.every((entry: { success?: boolean }) => entry.success)) throw new Error('temporarily_unavailable');
  return { deleted: true };
}

function analysisResult(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('invalid_provider_response');
  return sanitizeFeedbackMessage(value).slice(0, 4000);
}
export async function analyzeFeedback(input: FeedbackAdminInput & { analyze: (payload: FeedbackAnalysisInput) => Promise<string> }) {
  const row = await getRow(input.db, input.id, input.now);
  if (!row) throw new Error('not_found');
  if (!row.kind) throw new Error('invalid_feedback');
  let diagnostics: unknown | null = null;
  if (row.diagnostic_json_sanitized) try { diagnostics = JSON.parse(row.diagnostic_json_sanitized) as unknown; } catch { diagnostics = null; }
  const requested = await audit(input.db, input.adminUserId, 'feedback_analysis_requested', input.id, input.now).run();
  if (!requested.success) throw new Error('temporarily_unavailable');
  const summary = analysisResult(await input.analyze({ kind: row.kind, message: row.message_sanitized, diagnostics }));
  const result = await input.db.batch<{ success?: boolean; meta?: { changes?: number } }>([
    input.db.prepare("UPDATE feedback_submissions SET ai_summary=?,status=CASE WHEN status='new' THEN 'reviewing' ELSE status END,updated_at=? WHERE id=?")
      .bind(summary, input.now, input.id),
    audit(input.db, input.adminUserId, 'feedback_analyzed', input.id, input.now),
  ]);
  if (!result.every((entry: { success?: boolean }) => entry.success)) throw new Error('temporarily_unavailable');
  return { aiSummary: summary };
}

export async function createFeedbackIssue(input: FeedbackAdminInput & {
  repo: string; token?: string; draft: { title: string; body: string }; createIssue: (payload: FeedbackIssueInput) => Promise<FeedbackIssueResult>;
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo) || !input.token) throw new Error('not_configured');
  if (!input.draft || typeof input.draft.title !== 'string' || !input.draft.title.trim() || input.draft.title.length > 120 ||
      typeof input.draft.body !== 'string' || !input.draft.body.trim() || input.draft.body.length > 8000) throw new Error('invalid_issue_draft');
  const row = await getRow(input.db, input.id, input.now);
  if (!row) throw new Error('not_found');
  if (!row.kind) throw new Error('invalid_feedback');
  if (row.github_issue_state === 'done' && row.github_issue_number && row.github_issue_url) return { issueNumber: row.github_issue_number, issueUrl: row.github_issue_url };
  if (row.github_issue_state === 'unknown' || row.github_issue_state === 'in_progress') throw new Error('issue_submission_unknown');
  const title = sanitizeFeedbackMessage(input.draft.title).replace(/[\r\n\x00-\x1f]/g, ' ').trim();
  const draftBody = sanitizeFeedbackMessage(input.draft.body);
  if (!title || title.length > 120 || !draftBody.trim() || draftBody.length > 8000) throw new Error('invalid_issue_draft');
  const claim = await input.db.prepare("UPDATE feedback_submissions SET github_issue_state='in_progress',updated_at=? WHERE id=? AND github_issue_state='ready'").bind(input.now, input.id).run();
  if (!claim.success || claim.meta?.changes !== 1) throw new Error('issue_submission_unknown');
  let diagnostics = 'なし';
  if (row.diagnostic_json_sanitized) diagnostics = row.diagnostic_json_sanitized;
  const body = `${draftBody}\n\n## 診断情報（sanitized）\n\n\`\`\`json\n${diagnostics}\n\`\`\`\n\nfeedback_id: \`${row.id}\``;
  const idempotencyMarker = `kakeimatch-feedback:${row.id}`;
  const requested = await audit(input.db, input.adminUserId, 'feedback_issue_requested', input.id, input.now).run();
  if (!requested.success) throw new Error('temporarily_unavailable');
  let issue: FeedbackIssueResult;
  try { issue = await input.createIssue({ feedbackId: row.id, kind: row.kind, title, body, idempotencyMarker }); }
  catch {
    await input.db.prepare("UPDATE feedback_submissions SET github_issue_state='unknown',updated_at=? WHERE id=? AND github_issue_state='in_progress'").bind(input.now, input.id).run();
    throw new Error('issue_submission_unknown');
  }
  const expectedUrl = `https://github.com/${input.repo}/issues/${issue.number}`;
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0 || issue.url !== expectedUrl) {
    await input.db.prepare("UPDATE feedback_submissions SET github_issue_state='unknown',updated_at=? WHERE id=? AND github_issue_state='in_progress'").bind(input.now, input.id).run();
    throw new Error('issue_submission_unknown');
  }
  const results = await input.db.batch<{ success?: boolean; meta?: { changes?: number } }>([
    input.db.prepare("UPDATE feedback_submissions SET github_issue_state='done',github_issue_number=?,github_issue_url=?,status='issue_created',updated_at=? WHERE id=? AND github_issue_state='in_progress'")
      .bind(issue.number, issue.url, input.now, input.id),
    audit(input.db, input.adminUserId, 'feedback_issue_created', input.id, input.now),
  ]);
  if ((results[0] as { meta?: { changes?: number } })?.meta?.changes !== 1 || !results.every((entry: { success?: boolean }) => entry.success)) throw new Error('issue_submission_unknown');
  return { issueNumber: issue.number, issueUrl: issue.url };
}

/** Called by a scheduled Worker handler; expired feedback and encrypted originals are deleted together. */
export async function purgeExpiredFeedback(db: AccountD1Database, now: number): Promise<number> {
  const result = await db.prepare('DELETE FROM feedback_submissions WHERE retention_expires_at<=?').bind(now).run();
  if (!result.success) throw new Error('temporarily_unavailable');
  return result.meta?.changes ?? 0;
}
