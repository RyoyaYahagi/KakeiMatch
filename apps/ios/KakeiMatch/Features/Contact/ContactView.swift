import SwiftUI

struct ContactView: View {
    let onBackToSettings: () -> Void

    @State private var kind: KMContactKind?
    @State private var message = ""
    @State private var isSubmitting = false
    @State private var statusMessage: String?
    @State private var sentResult: KMContactResult?
    @State private var flowID: UUID?
    @State private var flowKey: String?
    @State private var attachDiagnostics = false
    @State private var diagnosticContext: KMContactDiagnosticContext?

    private var validation: KMContactPresentation.Validation {
        KMContactPresentation.validation(kind: kind, message: message)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            HStack(spacing: KMSpacing.space2) {
                Button(action: onBackToSettings) {
                    HStack(spacing: 2) {
                        KMIcon(name: "chevronLeft", size: 20)
                        Text("設定へ戻る")
                    }
                    .frame(minHeight: KMLayout.minimumHit)
                }
                .buttonStyle(KMButtonStyle(role: .text))
                .accessibilityIdentifier("contact-back")

                Spacer(minLength: 0)

                Text("お問い合わせ")
                    .font(KMTypography.heading)
                    .foregroundStyle(KMColor.text)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("contact-title")

                Spacer(minLength: 0)
            }
            .overlay(alignment: .bottom) { rule.padding(.bottom, -KMSpacing.space2) }

            Text("送信内容はKakeiMatchの運用担当者が確認できる内部Inboxに保存され、GitHubへ公開されません。内容を確認した後、必要な場合だけ開発用に加工してIssueを作成します。氏名や家計情報は入力しないでください。")
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(KMSpacing.space4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(KMColor.warningSoft, in: RoundedRectangle(cornerRadius: KMRadius.xl))
                .accessibilityIdentifier("contact-consent")

            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                fieldLabel("お問い合わせの種類")
                Picker("お問い合わせの種類", selection: $kind) {
                    Text("選択してください").tag(nil as KMContactKind?)
                    ForEach(KMContactKind.allCases) { option in
                        Text(option.title).tag(option as KMContactKind?)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .padding(.horizontal, KMSpacing.space3)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.lg))
                .overlay(RoundedRectangle(cornerRadius: KMRadius.lg).stroke(KMColor.borderStrong, lineWidth: 1))
                .accessibilityLabel("お問い合わせの種類")
                .accessibilityIdentifier("contact-kind")
            }

            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                fieldLabel("お問い合わせ内容")
                ZStack(alignment: .topLeading) {
                    if message.isEmpty {
                        Text("お困りのことや改善のご希望を入力してください")
                            .font(KMTypography.body(16))
                            .foregroundStyle(KMColor.muted)
                            .padding(.horizontal, KMSpacing.space3 + 4)
                            .padding(.vertical, KMSpacing.space3 + 4)
                            .accessibilityHidden(true)
                    }
                    TextEditor(text: Binding(
                        get: { message },
                        set: { message = KMContactPresentation.limitedMessage($0) }
                    ))
                        .font(KMTypography.body(16))
                        .foregroundStyle(KMColor.text)
                        .scrollContentBackground(.hidden)
                        .padding(KMSpacing.space2)
                        .accessibilityLabel("お問い合わせ内容")
                        .accessibilityIdentifier("contact-message")
                        .disabled(isSubmitting)
                }
                .frame(height: 210)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.lg))
                .overlay(RoundedRectangle(cornerRadius: KMRadius.lg).stroke(KMColor.borderStrong, lineWidth: 1))

                Text("\(KMContactPresentation.messageLength(message)) / \(KMContactPresentation.maximumMessageLength)文字")
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.muted)
                    .accessibilityIdentifier("contact-count")
            }

            diagnosticNotice

            if let statusMessage {
                Text(statusMessage)
                    .font(KMTypography.note)
                    .foregroundStyle(statusMessage.contains("送信できません") || statusMessage.contains("必要") ? KMColor.danger : KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("contact-status")
            }

            if let sentResult {
                sentConfirmation(sentResult)
            }

            Button(action: submit) {
                HStack(spacing: KMSpacing.space2) {
                    if isSubmitting { ProgressView().tint(KMColor.onPrimary) }
                    Text(isSubmitting ? "お問い合わせを送信しています…" : "送信する")
                }
                .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(KMButtonStyle(role: .primary))
            .disabled(isSubmitting || validation != .valid)
            .accessibilityIdentifier("contact-send")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("contact.screen")
        .onChange(of: message) { _, _ in invalidateFlow() }
        .onChange(of: kind) { _, _ in invalidateFlow() }
    }

    private var diagnosticNotice: some View {
        Button {
            attachDiagnostics.toggle()
            diagnosticContext = nil
        } label: {
            HStack(alignment: .top, spacing: KMSpacing.space3) {
                Image(systemName: attachDiagnostics ? "checkmark.square.fill" : "square")
                    .font(.system(size: 23, weight: .regular))
                    .foregroundStyle(attachDiagnostics ? KMColor.primary : KMColor.muted)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: KMSpacing.space1) {
                    Text("直前のアプリ動作情報を添付する")
                        .font(KMTypography.body(15, weight: .bold))
                        .foregroundStyle(KMColor.text)
                    Text("画面名・操作種別・安全なエラーコード・オンライン状態だけを使います。入力内容、金額、店名、レシートや明細の内容は含みません。")
                        .font(KMTypography.body(14))
                        .foregroundStyle(KMColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(KMSpacing.space3)
            .frame(maxWidth: .infinity, minHeight: KMLayout.minimumHit, alignment: .leading)
            .background(KMColor.sunken, in: RoundedRectangle(cornerRadius: KMRadius.lg))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
        .accessibilityLabel("直前のアプリ動作情報を添付する")
        .accessibilityValue(attachDiagnostics ? "オン" : "オフ")
        .accessibilityAddTraits(attachDiagnostics ? [.isSelected] : [])
        .accessibilityIdentifier("contact-diagnostics-optin")
    }

    private func sentConfirmation(_ result: KMContactResult) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(result.kind == kind?.apiKind ? kind?.resultTitle ?? "お問い合わせ" : "お問い合わせ")
                .font(KMTypography.body(17, weight: .bold))
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("contact-result-title")
            Text(result.reply)
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("contact-result-reply")
            Text("受付番号: \(result.feedbackId)")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .accessibilityIdentifier("contact-feedback-id")
            Text("送信した内容")
                .font(KMTypography.body(14, weight: .bold))
                .foregroundStyle(KMColor.text)
            Text(message)
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("contact-result-message")
            Text("お問い合わせを受け付けました。必要な場合のみ、確認後に開発用のIssueを作成します。")
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("contact-inbox-note")
            Button("内容を編集する") { sentResult = nil }
                .buttonStyle(KMButtonStyle(role: .secondary))
                .accessibilityIdentifier("contact-edit-result")
        }
        .padding(KMSpacing.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.border, lineWidth: 1))
        .accessibilityIdentifier("contact-result")
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .font(KMTypography.body(16))
            .foregroundStyle(KMColor.text)
            .accessibilityAddTraits(.isHeader)
    }

    private var rule: some View { Rectangle().fill(KMColor.border).frame(height: 1) }

    private func invalidateFlow() {
        guard !isSubmitting else { return }
        flowID = nil
        flowKey = nil
        sentResult = nil
        statusMessage = nil
    }

    private func submit() {
        guard !isSubmitting, validation == .valid, let kind else { return }
        let key = "\(kind.rawValue)\u{0}\(message)"
        if flowID == nil || flowKey != key {
            flowID = UUID()
            flowKey = key
        }
        guard let flowID else { return }
        let recorder = KMContactDiagnosticRecorder.shared
        if attachDiagnostics, diagnosticContext == nil {
            diagnosticContext = recorder.snapshot()
        }
        recorder.recordAction(.contactSubmitStarted, screen: .contact)
        isSubmitting = true
        statusMessage = "お問い合わせを送信しています…"
        Task {
            defer { isSubmitting = false }
            do {
                let configuration = try KMAPIConfiguration()
                let api = KMWorkerAPI(configuration: configuration)
                let response = try await api.submitContact(kind: kind.apiKind, message: message,
                                                           diagnostic: attachDiagnostics ? diagnosticContext : nil,
                                                           flowID: flowID)
                sentResult = response
                statusMessage = "お問い合わせを内部Inboxへ送りました。"
            } catch {
                recorder.recordFailure(error, screen: .contact)
                statusMessage = KMContactPresentation.failureMessage(for: error)
            }
        }
    }
}

