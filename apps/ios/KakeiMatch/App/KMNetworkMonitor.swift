import Foundation
import Network

/// Bridges NWPathMonitor callbacks to the diagnostic recorder. The recorder itself stays in
/// `KakeiMatchCore` and does not depend on Network.framework.
@MainActor
final class KMNetworkMonitor {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "jp.kakeimatch.network-monitor")
    private var started = false

    func start(_ onChange: @escaping @MainActor @Sendable (Bool) -> Void) {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { path in
            let online = path.status == .satisfied
            Task { @MainActor in onChange(online) }
        }
        monitor.start(queue: queue)
    }

    deinit { monitor.cancel() }
}
