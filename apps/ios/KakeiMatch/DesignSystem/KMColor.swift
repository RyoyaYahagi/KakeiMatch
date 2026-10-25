import SwiftUI
import UIKit

/// Static port of style.css :root / :root[data-theme="dark"].
/// CSS --border-strong → KMColor.borderStrong, --c-food-soft → KMColor.cFoodSoft, etc.
/// Resolve using the current trait collection; no screen-specific dark palettes.
enum KMColor {
    static func adaptive(_ light: UInt32, _ dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> Color {
        Color(uiColor: UIColor { traits in
            let isDark = traits.userInterfaceStyle == .dark
            let hex = isDark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255,
                           green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255,
                           alpha: isDark ? darkAlpha : lightAlpha)
        })
    }
    static let bg = adaptive(0xFAF6F1, 0x17120E)
    static let surface = adaptive(0xFFFFFF, 0x221B15)
    static let sunken = adaptive(0xF3EBE1, 0x2B221B)
    static let text = adaptive(0x2E2219, 0xF2E9E0)
    static let muted = adaptive(0x6E5F52, 0xB3A493)
    static let border = adaptive(0xECE2D7, 0x382D24)
    static let borderStrong = adaptive(0xC9B6A2, 0x5E4D3F)
    static let primary = adaptive(0xA94C16, 0xFFA56B)
    static let onPrimary = adaptive(0xFFFFFF, 0x2A1205)
    static let primarySoft = adaptive(0xFCE9DC, 0x3D2414)
    static let primaryPress = adaptive(0x8F3F11, 0xF08F50)
    static let success = adaptive(0xB3361F, 0xFF8C72)
    static let successSoft = adaptive(0xFBE7E1, 0x3B1D17)
    static let warning = adaptive(0x3F55B5, 0xAEB6FF)
    static let warningSoft = adaptive(0xE6EAFB, 0x262C55)
    static let missing = adaptive(0x8A3A78, 0xF0A6DA)
    static let missingSoft = adaptive(0xF6E5F0, 0x3A1E33)
    static let danger = adaptive(0x9E1B32, 0xFF8FA3)
    static let dangerSoft = adaptive(0xFBE3E7, 0x3D1820)
    static let income = adaptive(0x2D6FA8, 0x8DC0F0)
    static let cFood = adaptive(0xD9661F, 0xFFA766)
    static let cFoodSoft = adaptive(0xFFE8D6, 0x3B2616)
    static let cDaily = adaptive(0x0B7A68, 0x45C7A8)
    static let cDailySoft = adaptive(0xE4F5EF, 0x173A32)
    static let cTransport = adaptive(0x2D66B5, 0x8DB8F5)
    static let cTransportSoft = adaptive(0xE0EBFA, 0x182A44)
    static let cFun = adaptive(0xB23C74, 0xF28DBC)
    static let cFunSoft = adaptive(0xFBE2EE, 0x3A1A2B)
    static let cUtil = adaptive(0x946600, 0xF0C150)
    static let cUtilSoft = adaptive(0xFFF1C7, 0x3A2E0E)
    static let cComm = adaptive(0x6450BF, 0xB3A5F5)
    static let cCommSoft = adaptive(0xECE8FB, 0x241F45)
    static let cOther = adaptive(0x5E6A65, 0xA9B4AF)
    static let cOtherSoft = adaptive(0xE8ECEA, 0x262E2B)
    static let scrim = adaptive(0x2E2219, 0x000000, lightAlpha: 0.45, darkAlpha: 0.6)
}
