import SwiftUI

@main
struct KakeiMatchApp: App {
    var body: some Scene {
        WindowGroup { AppShell().preferredColorScheme(testColorScheme) }
    }

    /// Deterministic screenshots without changing the user's system preference.
    private var testColorScheme: ColorScheme? {
        #if DEBUG
        switch ProcessInfo.processInfo.environment["KM_UI_TEST_APPEARANCE"] {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
        #else
        return nil
        #endif
    }
}
