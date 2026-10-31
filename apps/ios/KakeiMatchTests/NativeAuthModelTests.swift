import Foundation
import Testing
@testable import KakeiMatch

@MainActor
@Suite
struct NativeAuthModelTests {
    @Test func signedOutWithoutGuestShowsFreeDailyUse() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedOut))
        await model.refresh()
        #expect(model.phase == .signedOut)
        #expect(model.showsSignedOutActions)
        #expect(!model.showsSignedInActions)
        #expect(model.usageSummary == KMNativeAuthPresentation.signedOutFreeUsage)
        #expect(model.settingsRowValue == "1日5回まで")
        #expect(model.usageFraction == nil)
        #expect(model.accountStatus == "未ログインです。")
    }

    @Test func guestUsageUsesPwaDailyLabelAndRowValue() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .guest))
        await model.refresh()
        #expect(model.phase == .signedOut)
        #expect(model.usageSummary == "今日のAI読み取り 2 / 5回 · 登録なし")
        #expect(model.settingsRowValue == "今日 2/5回")
        #expect(model.usageFraction == 0.4)
    }

    @Test func signedInShowsPlanUsagePasskeysAndLogout() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedIn))
        await model.refresh()
        #expect(model.phase == .signedIn)
        #expect(model.showsSignedInActions)
        #expect(model.accountStatus == "ログイン中：テスト利用者")
        #expect(model.usageSummary == "今月の読み取り 3 / 10回 · Free")
        #expect(model.settingsRowValue == "今月 3/10回")
        #expect(model.passkeys.count == 1)
        #expect(model.passkeysLoaded)

        await model.signOut()
        #expect(model.phase == .signedOut)
        #expect(model.message == KMNativeAuthPresentation.logoutDone)
        #expect(model.settingsRowValue == "1日5回まで")
        #expect(model.passkeys.isEmpty)
    }

    @Test func passkeyLoginRefreshesAndIssuesAccountToken() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedOut))
        await model.signInWithPasskey()
        #expect(model.phase == .signedIn)
        #expect(model.message == KMNativeAuthPresentation.tokenReady)
        #expect(model.accountName == "テスト利用者")
    }

    @Test func invitationRegistrationUsesContextAndEndsSignedIn() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedOut))
        await model.registerWithInvitation("synthetic-invite")
        #expect(model.phase == .signedIn)
        #expect(model.message == KMNativeAuthPresentation.tokenReady)
        await model.registerWithInvitation("   ")
        #expect(model.phase == .signedIn)
    }

    @Test func unsupportedDeviceExplainsCloudStopWithoutTouchingHousehold() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .unsupported))
        await model.refresh()
        #expect(model.phase == .unavailable)
        #expect(model.isUnavailable)
        #expect(!model.showsSignedOutActions)
        #expect(!model.showsSignedInActions)
        #expect(model.usageSummary == KMNativeAuthPresentation.unsupportedDetail)
        #expect(model.usageSummary.contains("家計簿の閲覧や編集"))
        #expect(model.settingsRowValue == nil)
    }

    @Test func missingWorkerConfigurationIsSeparateFromUnsupportedDevice() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .notConfigured))
        await model.refresh()
        #expect(model.phase == .unavailable)
        #expect(model.usageSummary == KMNativeAuthPresentation.notConfiguredDetail)
    }

    @Test func accountDeletionKeepsLocalHouseholdAndShowsPwaCopy() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedIn))
        await model.refresh()
        await model.deleteAccount()
        #expect(model.phase == .signedOut)
        #expect(model.message == KMNativeAuthPresentation.accountDeleteDone)
        #expect(model.usageSummary == KMNativeAuthPresentation.accountDeletedUsage)
        #expect(model.settingsRowValue == nil)
    }

    @Test func addAndDeletePasskeyReloadTheList() async {
        let service = KMFakeNativeAuthService(initial: .signedIn)
        let model = KMNativeAuthModel(service: service)
        await model.refresh()
        await model.addPasskey()
        #expect(model.message == KMNativeAuthPresentation.passkeyAdded)
        #expect(model.passkeys.count == 2)
        await model.deletePasskey(model.passkeys[0])
        #expect(model.passkeys.count == 1)
    }
}
