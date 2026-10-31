import Foundation

/// category-tone.ts order and UInt32 wrapping hash, including Unicode scalar iteration.
/// Colors stay in DesignSystem so Data-layer aggregation does not depend on SwiftUI.
enum KMCategoryTone: String, CaseIterable, Sendable {
    case food, daily, transport, fun, util, comm, other

    private static let known: [(words: [String], tone: KMCategoryTone, icon: String)] = [
        (["食費", "食料", "食品"], .food, "cart"),
        (["外食", "飲食店", "カフェ"], .food, "cart"),
        (["日用品", "生活用品"], .daily, "basket"),
        (["衣服", "衣類", "被服", "美容"], .fun, "shirt"),
        (["交通", "電車", "バス", "ガソリン"], .transport, "train"),
        (["医療", "健康", "病院", "薬"], .comm, "medical"),
        (["家電", "デジタル", "ガジェット"], .comm, "phone"),
        (["娯楽", "趣味", "レジャー"], .fun, "heart"),
        (["AI", "ソフトウェア", "アプリ"], .comm, "tag"),
        (["通信", "携帯", "スマホ", "インターネット"], .comm, "phone"),
        (["教育", "学習", "教材", "資格"], .daily, "tag"),
        (["交際", "プレゼント", "贈答"], .fun, "heart"),
        (["住居", "家賃", "住宅"], .util, "bank"),
        (["光熱", "水道", "電気", "ガス"], .util, "bulb")
    ]

    static func visual(name: String, id: String? = nil) -> (tone: KMCategoryTone, icon: String) {
        if let match = known.first(where: { entry in entry.words.contains(where: name.contains) }) {
            return (match.tone, match.icon)
        }
        let hash = (id ?? name).unicodeScalars.reduce(UInt32(0)) { ($0 &* 31) &+ $1.value }
        return (allCases[Int(hash % 6)], "tag")
    }
}
