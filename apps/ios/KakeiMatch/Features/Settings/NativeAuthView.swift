import SwiftUI

/// PWA `settings-page-ai` (ログイン・利用状況).
///
/// The screen only touches the cloud adapter; household repositories are not
/// consulted, so an unavailable or signed-out account never blocks local use.
struct KMNativeAuthView: View {
    let model: KMNativeAuthModel
    let onBack: () -> Void
    var onShowHome: () -> Void = {}

    @State private var showsInvite = false
    @State private var invitation = ""
    @State private var passkeyToDelete: KMCloudPasskey?
    @State private var showsDeleteConfirm = false
    @State private var showsDeleteTyping = false
    @State private var deleteTyping = ""

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text(KMNativeAuthPresentation.pageTitle)
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("settings-page-ai-title")

            VStack(alignment: .leading, spacing: KMSpacing.space4) {
                accountHeader
                usageCard
                if model.showsSignedOutActions { signedOutActions }
                if model.showsSignedInActions { signedInActions }
                if let message = model.message {
                    Text(message)
                        .font(KMTypography.note)
                        .foregroundStyle(messageColor(message))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("account-message")
                }
            }
            .padding(.vertical, KMSpacing.space4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { rule }
            .overlay(alignment: .bottom) { rule }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("nativeAuth.screen")
        .alert(KMNativeAuthPresentation.invitePrompt, isPresented: $showsInvite) {
            TextField("招待コード", text: $invitation)
            Button("登録する") {
                let value = invitation
                invitation = ""
                Task { await model.registerWithInvitation(value) }
            }
            .disabled(!KMNativeAuthPresentation.invitationIsValid(invitation))
            Button("キャンセル", role: .cancel) { invitation = "" }
        }
        .alert("Passkeyを削除しますか？", isPresented: passkeyDeleteBinding, presenting: passkeyToDelete) { passkey in
            Button("削除する", role: .destructive) {
                passkeyToDelete = nil
                Task { await model.deletePasskey(passkey) }
            }
            Button("キャンセル", role: .cancel) { passkeyToDelete = nil }
        } message: { passkey in
            Text("\(passkey.name ?? "このPasskey")を削除しますか？")
        }
        .confirmationDialog("Cloud accountを削除しますか？", isPresented: $showsDeleteConfirm, titleVisibility: .visible) {
            Button("削除する", role: .destructive) {
                deleteTyping = ""
                showsDeleteTyping = true
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text(KMNativeAuthPresentation.accountDeleteConfirm)
        }
        .alert(KMNativeAuthPresentation.accountDeletePrompt, isPresented: $showsDeleteTyping) {
            TextField(KMNativeAuthPresentation.accountDeleteTyping, text: $deleteTyping)
            Button("削除する", role: .destructive) {
                guard KMNativeAuthPresentation.deletionConfirmationMatches(deleteTyping) else { return }
                deleteTyping = ""
                Task { await model.deleteAccount() }
            }
            .disabled(!KMNativeAuthPresentation.deletionConfirmationMatches(deleteTyping))
            Button("キャンセル", role: .cancel) { deleteTyping = "" }
        }
    }

    private var backButton: some View {
        Button(action: onBack) {
            HStack(spacing: 2) {
                KMIcon(name: "chevronLeft", size: 20)
                Text("設定")
            }
            .frame(minHeight: KMLayout.minimumHit)
        }
        .buttonStyle(KMButtonStyle(role: .text))
        .accessibilityLabel("設定へ戻る")
        .accessibilityIdentifier("settings.back")
    }

    private var accountHeader: some View {
        HStack(alignment: .center, spacing: KMSpacing.space4) {
            KMIcon(name: "scan", size: 26)
                .foregroundStyle(KMColor.cDaily)
                .frame(width: 52, height: 52)
                .background(KMColor.cDailySoft, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(KMNativeAuthPresentation.accountHeading)
                    .font(KMTypography.body(16, weight: .bold))
                    .foregroundStyle(KMColor.text)
                Text(model.accountStatus)
                    .font(KMTypography.body(14))
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("account-status")
            }
        }
    }

    private var usageCard: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(model.usageSummary)
                .font(KMTypography.body(16, weight: .bold))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("usage-summary")

            if let fraction = model.usageFraction {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(KMColor.surface)
                        Capsule()
                            .fill(KMColor.primary)
                            .frame(width: max(0, geometry.size.width * fraction))
                    }
                }
                .frame(height: 10)
                .accessibilityHidden(true)
                .accessibilityIdentifier("usage-meter")
            }

            Text(KMNativeAuthPresentation.usageExplanation)
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, KMSpacing.space4)
        .padding(.vertical, KMSpacing.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(KMColor.sunken, in: RoundedRectangle(cornerRadius: KMRadius.lg))
    }

    private var signedOutActions: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(KMNativeAuthPresentation.signedOutLead)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 0) {
                    loginButton
                    inviteButton
                }
                VStack(alignment: .leading, spacing: 0) {
                    loginButton
                    inviteButton
                }
            }
            Button("家計簿に戻る") { onShowHome() }
                .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
                .accessibilityIdentifier("manual-entry")
        }
        .accessibilityIdentifier("signed-out-actions")
    }

    private var loginButton: some View {
        Button("Passkeyで続ける") {
            Task { await model.signInWithPasskey() }
        }
        .buttonStyle(KMButtonStyle(role: .primary, width: .intrinsic))
        .disabled(model.busy)
        .accessibilityIdentifier("passkey-login")
    }

    private var inviteButton: some View {
        Button {
            showsInvite = true
        } label: {
            HStack(spacing: KMSpacing.space1) {
                KMIcon(name: "key", size: 18)
                Text("招待コードで登録")
            }
        }
        .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
        .disabled(model.busy)
        .accessibilityIdentifier("invite-register")
    }

    private var signedInActions: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Button("AI利用を確認") {
                Task { await model.issueAIToken() }
            }
            .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
            .disabled(model.busy)
            .accessibilityIdentifier("use-ai")

            Text("Passkey")
                .font(KMTypography.body(15, weight: .bold))
                .foregroundStyle(KMColor.text)
                .padding(.top, KMSpacing.space4)
                .accessibilityAddTraits(.isHeader)

            passkeyList

            Button {
                Task { await model.addPasskey() }
            } label: {
                HStack(spacing: KMSpacing.space1) {
                    KMIcon(name: "add", size: 18)
                    Text("Passkeyを追加")
                }
            }
            .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
            .disabled(model.busy)
            .accessibilityIdentifier("add-passkey")

            Button("ログアウト") {
                Task { await model.signOut() }
            }
            .buttonStyle(KMButtonStyle(role: .text))
            .disabled(model.busy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("logout")

            Text(KMNativeAuthPresentation.logoutNote)
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                Text(KMNativeAuthPresentation.accountDeleteNote)
                    .font(KMTypography.body(14))
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button("アカウントを削除") { showsDeleteConfirm = true }
                    .buttonStyle(KMButtonStyle(role: .destructive))
                    .disabled(model.busy)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("delete-account")
            }
            .padding(.top, KMSpacing.space3)
            .overlay(alignment: .top) { rule }
            .padding(.top, KMSpacing.space4)
        }
        .accessibilityIdentifier("signed-in-actions")
    }

    @ViewBuilder private var passkeyList: some View {
        if model.passkeysLoaded && model.passkeys.isEmpty {
            Text(KMNativeAuthPresentation.passkeyEmpty)
                .font(KMTypography.text)
                .foregroundStyle(KMColor.text)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .accessibilityIdentifier("passkey-list")
        } else if !model.passkeys.isEmpty {
            VStack(spacing: 0) {
                ForEach(model.passkeys, id: \.id) { passkey in
                    HStack(spacing: KMSpacing.space2) {
                        Text(passkey.name ?? "Passkey")
                            .font(KMTypography.text)
                            .foregroundStyle(KMColor.text)
                        Spacer(minLength: KMSpacing.space2)
                        Button("削除") { passkeyToDelete = passkey }
                            .buttonStyle(KMButtonStyle(role: .destructive))
                            .accessibilityLabel("\(passkey.name ?? "このPasskey")を削除")
                            .accessibilityIdentifier("passkey-delete.\(passkey.id)")
                    }
                    .frame(minHeight: 48)
                }
            }
            .accessibilityIdentifier("passkey-list")
        } else {
            Text(KMNativeAuthPresentation.passkeyListFailed)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .accessibilityIdentifier("passkey-list")
        }
    }

    private var rule: some View { Rectangle().fill(KMColor.border).frame(height: 1) }

    private var passkeyDeleteBinding: Binding<Bool> {
        Binding(get: { passkeyToDelete != nil }, set: { if !$0 { passkeyToDelete = nil } })
    }

    private func messageColor(_ message: String) -> Color {
        if message == KMNativeAuthPresentation.loginFailed
            || message == KMNativeAuthPresentation.registerFailed
            || message == KMNativeAuthPresentation.passkeyListFailed
            || message == KMNativeAuthPresentation.passkeyAddFailed
            || message == KMNativeAuthPresentation.passkeyDeleteFailed
            || message == KMNativeAuthPresentation.logoutFailed
            || message == KMNativeAuthPresentation.accountDeleteSessionExpired
            || message == KMNativeAuthPresentation.accountDeleteFailed {
            return KMColor.danger
        }
        return KMColor.muted
    }
}
