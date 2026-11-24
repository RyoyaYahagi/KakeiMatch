import Foundation
import Observation

@MainActor @Observable
final class KMNativeAIConsent {
    static let shared = KMNativeAIConsent()
    static let preferenceKey = "km.nativeAIConsent.disclosureVersion"
    static let disclosureVersion = 2

    var isPresented = false
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var pendingAction: (@MainActor () -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasConsented: Bool {
        defaults.integer(forKey: Self.preferenceKey) >= Self.disclosureVersion
    }

    func request(_ action: @escaping @MainActor () -> Void) {
        guard !hasConsented else { action(); return }
        pendingAction = action
        isPresented = true
    }

    func accept() {
        guard isPresented else { return }
        defaults.set(Self.disclosureVersion, forKey: Self.preferenceKey)
        isPresented = false
        let action = pendingAction
        pendingAction = nil
        action?()
    }

    func decline() {
        isPresented = false
        pendingAction = nil
    }

    static let disclosure = """
    同意すると、次の情報をKakeiMatchのサーバー経由で外部AIへ送ります。拒否しても手入力で使い続けられます。

    レシート: 電話番号・カード番号などを端末内で隠した写真をGoogle Geminiへ送り、分類が必要な場合は店名・合計金額・品目名と各金額・候補カテゴリをGoogle Geminiにも送ります。
    給与明細: 個人情報を隠した画像をGoogle Geminiへ送ります。
    分類（MoneyForwardを含む）: 店名・金額・品目名と金額、または取込元カテゴリ名と候補カテゴリをGoogle Geminiへ送ります。

    この説明文の版への同意を端末に保存します。説明文の版が変わると、次回の送信前に改めて確認します。
    """
}
