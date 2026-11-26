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

    @Test func dailyCapUsageSaysTodayAndKeepsMonthlyCopyForPlans() {
        #expect(KMNativeAuthPresentation.usageSummary(plan: "free", period: "day", used: 2, limit: 5) == "今日のAI読み取り 2 / 5回 · Free")
        #expect(KMNativeAuthPresentation.usageSummary(plan: "free", period: "day", used: 3, limit: nil) == "今日のAI読み取り 3回 · Free · 上限なし")
        #expect(KMNativeAuthPresentation.usageSummary(plan: "free", period: "month", used: 3, limit: 10) == "今月の読み取り 3 / 10回 · Free")
        #expect(KMNativeAuthPresentation.settingsRowValue(plan: "free", period: "day", used: 2, limit: 5) == "今日 2/5回")
        #expect(KMNativeAuthPresentation.settingsRowValue(plan: "free", period: "day", used: 3, limit: nil) == "今日 3回")
        #expect(KMNativeAuthPresentation.settingsRowValue(plan: "free", period: "month", used: 3, limit: 10) == "今月 3/10回")
    }

    @Test func meterClampsAndNeverDividesByZero() {
        #expect(KMNativeAuthPresentation.usageFraction(plan: "guest", used: 0, limit: 5) == 0)
        #expect(KMNativeAuthPresentation.usageFraction(plan: "guest", used: 9, limit: 5) == 1)
        #expect(KMNativeAuthPresentation.usageFraction(plan: "guest", used: 1, limit: 0) == nil)
        #expect(KMNativeAuthPresentation.usageFraction(plan: "free", used: 1, limit: -1) == nil)
    }

    @Test func nativeGuidanceExplainsLocalUseWithoutAccountPrompts() {
        #expect(KMNativeAuthPresentation.signedOutFreeUsage.contains("1日5回"))
        #expect(KMNativeAuthPresentation.usageLead.contains("正規のアプリ"))
        #expect(KMNativeAuthPresentation.usageLead.contains("家計データは保存しません"))
        #expect(KMNativeAuthPresentation.usageLead.contains("家計簿の閲覧や編集"))
        #expect(KMNativeAuthPresentation.unsupportedDetail.contains("AI機能を利用できません"))
        #expect(KMNativeAuthPresentation.unsupportedDetail.contains("家計簿の閲覧や編集"))
        #expect(KMNativeAuthPresentation.notConfiguredDetail.contains("家計簿の閲覧や編集"))
        for copy in [
            KMNativeAuthPresentation.pageTitle,
            KMNativeAuthPresentation.unavailableStatus,
            KMNativeAuthPresentation.unsupportedDetail,
            KMNativeAuthPresentation.signedOutFreeUsage,
            KMNativeAuthPresentation.usageLead,
            KMNativeAuthPresentation.usageExplanation,
            KMNativeAuthPresentation.guestStartMessage,
        ] {
            #expect(!copy.contains("ログイン"))
            #expect(!copy.contains("アカウント"))
            #expect(!copy.contains("お問い合わせ"))
        }
    }

    @Test func settingsRowCarriesUsageValueAndOpensUsagePage() {
        let sections = KMSettingsPresentation.sections(theme: .system, aiUsageValue: "今日 2/5回")
        #expect(sections[2].rows[0].title == "利用状況")
        #expect(sections[2].rows[0].value == "今日 2/5回")
        #expect(sections[2].rows[0].destination == .ai)
    }
}
