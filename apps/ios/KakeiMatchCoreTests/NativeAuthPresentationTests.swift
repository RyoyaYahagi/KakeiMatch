import Testing
@testable import KakeiMatchCore

struct NativeAuthPresentationTests {
    @Test func guestUsageMatchesPWARenderUsageAndRowValue() {
        #expect(KMNativeAuthPresentation.usageSummary(plan: "guest", used: 2, limit: 5) == "今日のAI読み取り 2 / 5回 · 登録なし")
        #expect(KMNativeAuthPresentation.settingsRowValue(plan: "guest", used: 2, limit: 5) == "今日 2/5回")
        #expect(KMNativeAuthPresentation.usageFraction(plan: "guest", used: 2, limit: 5) == 0.4)
    }

    @Test func accountUsageMatchesPWAPlanNamesAndUnlimitedRule() {
        #expect(KMNativeAuthPresentation.usageSummary(plan: "free", used: 3, limit: 10) == "今月の読み取り 3 / 10回 · Free")
        #expect(KMNativeAuthPresentation.usageSummary(plan: "pro", used: 3, limit: 50) == "今月の読み取り 3 / 50回 · Pro")
        #expect(KMNativeAuthPresentation.usageSummary(plan: "family", used: 3, limit: 50) == "今月の読み取り 3 / 50回 · Plus")
        #expect(KMNativeAuthPresentation.usageSummary(plan: "free", used: 3, limit: nil) == "今月の読み取り 3回 · Free · 上限なし")
        #expect(KMNativeAuthPresentation.settingsRowValue(plan: "free", used: 3, limit: 10) == "今月 3/10回")
        #expect(KMNativeAuthPresentation.settingsRowValue(plan: "free", used: 3, limit: nil) == "今月 3回")
        #expect(KMNativeAuthPresentation.usageFraction(plan: "free", used: 3, limit: nil) == nil)
    }

    @Test func meterClampsAndNeverDividesByZero() {
        #expect(KMNativeAuthPresentation.usageFraction(plan: "guest", used: 0, limit: 5) == 0)
        #expect(KMNativeAuthPresentation.usageFraction(plan: "guest", used: 9, limit: 5) == 1)
        #expect(KMNativeAuthPresentation.usageFraction(plan: "guest", used: 1, limit: 0) == nil)
        #expect(KMNativeAuthPresentation.usageFraction(plan: "free", used: 1, limit: -1) == nil)
    }

    @Test func accountStatusUsesPWAWording() {
        #expect(KMNativeAuthPresentation.accountStatus(isSignedIn: false, name: "だれか") == "未ログインです。")
        #expect(KMNativeAuthPresentation.accountStatus(isSignedIn: true, name: nil) == "ログイン中")
        #expect(KMNativeAuthPresentation.accountStatus(isSignedIn: true, name: "  ") == "ログイン中")
        #expect(KMNativeAuthPresentation.accountStatus(isSignedIn: true, name: "山田") == "ログイン中：山田")
    }

    @Test func nativeGuidanceExplainsUnsupportedDeviceWithoutBreakingLocalUse() {
        #expect(KMNativeAuthPresentation.signedOutLead.contains("1日5回"))
        #expect(KMNativeAuthPresentation.signedOutLead.contains("正規のアプリ"))
        #expect(KMNativeAuthPresentation.signedOutLead.contains("家計データは保存しません"))
        #expect(KMNativeAuthPresentation.unsupportedDetail.contains("クラウドのログインとAI機能"))
        #expect(KMNativeAuthPresentation.unsupportedDetail.contains("家計簿の閲覧や編集"))
        #expect(KMNativeAuthPresentation.notConfiguredDetail.contains("家計簿の閲覧や編集"))
        #expect(!KMNativeAuthPresentation.accountDeleteConfirm.contains("家計簿・レシート・明細・照合記録は残ります") == false)
    }

    @Test func invitationMustBeNonEmptyAndBounded() {
        #expect(!KMNativeAuthPresentation.invitationIsValid(""))
        #expect(!KMNativeAuthPresentation.invitationIsValid("   "))
        #expect(KMNativeAuthPresentation.invitationIsValid("invite-token"))
        #expect(!KMNativeAuthPresentation.invitationIsValid(String(repeating: "a", count: 4097)))
        #expect(KMNativeAuthPresentation.invitationIsValid(String(repeating: "a", count: 4096)))
    }

    @Test func accountDeletionRequiresTheExactTypedPhrase() {
        #expect(KMNativeAuthPresentation.deletionConfirmationMatches("アカウントを削除"))
        #expect(!KMNativeAuthPresentation.deletionConfirmationMatches("アカウント削除"))
        #expect(!KMNativeAuthPresentation.deletionConfirmationMatches("アカウントを削除 "))
    }

    @Test func settingsRowCarriesUsageValueAndOpensAuthPage() {
        let sections = KMSettingsPresentation.sections(theme: .system, screenLockEnabled: false, aiUsageValue: "今日 2/5回")
        #expect(sections[2].rows[0].title == "ログイン・利用状況")
        #expect(sections[2].rows[0].value == "今日 2/5回")
        #expect(sections[2].rows[0].destination == .ai)
    }
}
