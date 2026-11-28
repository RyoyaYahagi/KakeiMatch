import Foundation
import Testing
@testable import KakeiMatch

@MainActor
@Suite
struct NativeAuthModelTests {
    @Test func signedOutWithoutGuestShowsFreeDailyUseAndNoSupportId() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedOut))
        await model.refresh()
        #expect(model.phase == .signedOut)
        #expect(model.usageSummary == KMNativeAuthPresentation.signedOutFreeUsage)
        #expect(model.settingsRowValue == "1日5回まで")
        #expect(model.usageFraction == nil)
        #expect(model.supportId == nil)
    }

    @Test func guestUsageUsesPwaDailyLabelRowValueAndOptionalSupportId() async {
        let withoutSupportId = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .guest))
        await withoutSupportId.refresh()
        #expect(withoutSupportId.phase == .signedOut)
        #expect(withoutSupportId.usageSummary == "今日のAI読み取り 2 / 5回 · 登録なし")
        #expect(withoutSupportId.settingsRowValue == "今日 2/5回")
        #expect(withoutSupportId.usageFraction == 0.4)
        #expect(withoutSupportId.supportId == nil)

        let withSupportId = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .guest, supportId: "  sup_guest_1  "))
        await withSupportId.refresh()
        #expect(withSupportId.supportId == "sup_guest_1")
    }

    @Test func signedInKeepsMonthlyAndDailyUsageDisplayAndNormalizesSupportId() async {
        let monthly = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedIn, supportId: "sup_monthly"))
        await monthly.refresh()
        #expect(monthly.phase == .signedIn)
        #expect(monthly.usageSummary == "今月の読み取り 3 / 10回 · Free")
        #expect(monthly.settingsRowValue == "今月 3/10回")
        #expect(monthly.supportId == "sup_monthly")

        let daily = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .signedInDaily, supportId: "   "))
        await daily.refresh()
        #expect(daily.phase == .signedIn)
        #expect(daily.usageSummary == "今日のAI読み取り 2 / 5回 · Free")
        #expect(daily.settingsRowValue == "今日 2/5回")
        #expect(daily.supportId == nil)
    }

    @Test func unsupportedDeviceExplainsCloudStopWithoutTouchingHousehold() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .unsupported, supportId: "sup_ignored"))
        await model.refresh()
        #expect(model.phase == .unavailable)
        #expect(model.isUnavailable)
        #expect(model.usageSummary == KMNativeAuthPresentation.unsupportedDetail)
        #expect(model.usageSummary.contains("家計簿の閲覧や編集"))
        #expect(model.settingsRowValue == nil)
        #expect(model.supportId == nil)
    }

    @Test func missingWorkerConfigurationIsSeparateFromUnsupportedDevice() async {
        let model = KMNativeAuthModel(service: KMFakeNativeAuthService(initial: .notConfigured))
        await model.refresh()
        #expect(model.phase == .unavailable)
        #expect(model.usageSummary == KMNativeAuthPresentation.notConfiguredDetail)
        #expect(model.supportId == nil)
    }
}
