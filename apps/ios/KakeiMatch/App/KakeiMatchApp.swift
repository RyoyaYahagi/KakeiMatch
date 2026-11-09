import GoogleSignIn
import SwiftUI

@main
struct KakeiMatchApp: App {
    private let repositories: Result<KMRepositories, Error>

    init() { repositories = Result { try KMFixtureLoader.launch() } }

    var body: some Scene {
        WindowGroup {
            Group {
                switch repositories {
                case .success(let value):
                    KMRootView(repositories: value)
                case .failure(let error):
                    Text(error.localizedDescription).accessibilityIdentifier("data.fixtureError")
                }
            }
            // The Google sign-in flow returns through the app's URL scheme. The
            // SDK only gets the URL; when the feature is off this is the only
            // Google entry point that is ever called.
            .onOpenURL { url in
                _ = GIDSignIn.sharedInstance.handle(url)
            }
        }
    }
}

/// Owns the Drive sync model for the whole process so the launch/foreground
/// upload and the settings page share one in-flight upload and one status.
@MainActor
private struct KMRootView: View {
    let repositories: KMRepositories
    @State private var driveSync: KMDriveSyncModel

    init(repositories: KMRepositories) {
        self.repositories = repositories
        let referenceDate = repositories.referenceDate
        let isFixture = repositories.fixtureName != nil
        _driveSync = State(initialValue: KMDriveSyncModel(
            now: isFixture ? { KMFixtureClock.now(reference: referenceDate) } : { Date() }))
    }

    var body: some View {
        AppShell()
            .environment(\.repositories, repositories)
            .environment(\.driveSync, driveSync)
    }
}
