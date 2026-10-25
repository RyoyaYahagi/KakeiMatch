import SwiftUI

@main
struct KakeiMatchApp: App {
    private let repositories: Result<KMRepositories, Error>

    init() { repositories = Result { try KMFixtureLoader.launch() } }

    var body: some Scene {
        WindowGroup {
            switch repositories {
            case .success(let value):
                AppShell().environment(\.repositories, value).preferredColorScheme(testColorScheme)
            case .failure(let error):
                Text(error.localizedDescription).accessibilityIdentifier("data.fixtureError")
            }
        }
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
