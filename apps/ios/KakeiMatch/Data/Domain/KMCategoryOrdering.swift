import Foundation

// TS: apps/pwa/src/category-tone.ts categoryRank (same first-match aliases as the PWA).
enum KMCategoryOrdering {
    private static let words = [
        ["食費", "食料", "食品"], ["外食", "飲食店", "カフェ"], ["日用品", "生活用品"],
        ["衣服", "衣類", "被服", "美容"], ["交通", "電車", "バス", "ガソリン"], ["医療", "健康", "病院", "薬"],
        ["家電", "デジタル", "ガジェット"], ["娯楽", "趣味", "レジャー"], ["AI", "ソフトウェア", "アプリ"],
        ["通信", "携帯", "スマホ", "インターネット"], ["教育", "学習", "教材", "資格"], ["交際", "プレゼント", "贈答"],
        ["住居", "家賃", "住宅"], ["光熱", "水道", "電気", "ガス"]
    ]
    static func rank(_ name: String) -> Int { words.firstIndex { $0.contains(where: name.contains) } ?? 999 }
}
