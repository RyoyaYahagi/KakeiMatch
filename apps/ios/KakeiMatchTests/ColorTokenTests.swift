import Testing
import SwiftUI
import UIKit
@testable import KakeiMatch

struct ColorTokenTests {
    @Test @MainActor func baselinePalettes() {
        let pairs: [(Color, UInt32, UInt32)] = [
            (KMColor.bg, 0xFAF6F1, 0x17120E),
            (KMColor.surface, 0xFFFFFF, 0x221B15),
            (KMColor.sunken, 0xF3EBE1, 0x2B221B),
            (KMColor.text, 0x2E2219, 0xF2E9E0),
            (KMColor.muted, 0x6E5F52, 0xB3A493),
            (KMColor.border, 0xECE2D7, 0x382D24),
            (KMColor.borderStrong, 0xC9B6A2, 0x5E4D3F),
            (KMColor.primary, 0xA94C16, 0xFFA56B),
            (KMColor.onPrimary, 0xFFFFFF, 0x2A1205),
            (KMColor.primarySoft, 0xFCE9DC, 0x3D2414),
            (KMColor.primaryPress, 0x8F3F11, 0xF08F50),
            (KMColor.success, 0xB3361F, 0xFF8C72),
            (KMColor.successSoft, 0xFBE7E1, 0x3B1D17),
            (KMColor.warning, 0x3F55B5, 0xAEB6FF),
            (KMColor.warningSoft, 0xE6EAFB, 0x262C55),
            (KMColor.missing, 0x8A3A78, 0xF0A6DA),
            (KMColor.missingSoft, 0xF6E5F0, 0x3A1E33),
            (KMColor.danger, 0x9E1B32, 0xFF8FA3),
            (KMColor.dangerSoft, 0xFBE3E7, 0x3D1820),
            (KMColor.income, 0x2D6FA8, 0x8DC0F0),
            (KMColor.cFood, 0xD9661F, 0xFFA766),
            (KMColor.cFoodSoft, 0xFFE8D6, 0x3B2616),
            (KMColor.cDaily, 0x0B7A68, 0x45C7A8),
            (KMColor.cDailySoft, 0xE4F5EF, 0x173A32),
            (KMColor.cTransport, 0x2D66B5, 0x8DB8F5),
            (KMColor.cTransportSoft, 0xE0EBFA, 0x182A44),
            (KMColor.cFun, 0xB23C74, 0xF28DBC),
            (KMColor.cFunSoft, 0xFBE2EE, 0x3A1A2B),
            (KMColor.cUtil, 0x946600, 0xF0C150),
            (KMColor.cUtilSoft, 0xFFF1C7, 0x3A2E0E),
            (KMColor.cComm, 0x6450BF, 0xB3A5F5),
            (KMColor.cCommSoft, 0xECE8FB, 0x241F45),
            (KMColor.cOther, 0x5E6A65, 0xA9B4AF),
            (KMColor.cOtherSoft, 0xE8ECEA, 0x262E2B),
        ]
        for (color, light, dark) in pairs {
            for (style, expected) in [(UIUserInterfaceStyle.light, light), (.dark, dark)] {
                let resolved = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
                var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                #expect(resolved.getRed(&r, green: &g, blue: &b, alpha: &a))
                #expect(Int((r * 255).rounded()) == Int((expected >> 16) & 255))
                #expect(Int((g * 255).rounded()) == Int((expected >> 8) & 255))
                #expect(Int((b * 255).rounded()) == Int(expected & 255))
                #expect(a == 1)
            }
        }
    }
}
