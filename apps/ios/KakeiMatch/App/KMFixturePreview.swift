#if DEBUG
import SwiftUI

/// `#Preview { KMFixturePreview("migration") { HomeView() } }`
/// A failed fixture is visible rather than silently replaced with empty data.
@MainActor struct KMFixturePreview<Content: View>: View {
    private let repositories: Result<KMRepositories, Error>
    private let content: Content
    init(_ name: String = "migration", @ViewBuilder content: () -> Content) {
        repositories = Result { try KMFixtureLoader.load(named: name) }
        self.content = content()
    }
    var body: some View {
        switch repositories {
        case .success(let value): content.environment(\.repositories, value)
        case .failure(let error): Text(error.localizedDescription)
        }
    }
}
#endif
