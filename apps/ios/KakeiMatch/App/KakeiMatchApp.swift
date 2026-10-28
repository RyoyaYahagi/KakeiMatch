import SwiftUI

@main
struct KakeiMatchApp: App {
    private let repositories: Result<KMRepositories, Error>

    init() { repositories = Result { try KMFixtureLoader.launch() } }

    var body: some Scene {
        WindowGroup {
            switch repositories {
            case .success(let value):
                AppShell().environment(\.repositories, value)
            case .failure(let error):
                Text(error.localizedDescription).accessibilityIdentifier("data.fixtureError")
            }
        }
    }
}
