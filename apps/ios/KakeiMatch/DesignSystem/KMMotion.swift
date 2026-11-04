import SwiftUI

/// docs/DESIGN.md 動き: motion only explains a state change and lasts about 200 ms.
/// When the system "Reduce Motion" setting is on, every motion stops and the final state appears at once.
enum KMMotion {
    /// Open/close, rows leaving a list, values replacing placeholders.
    static let standard: Animation = .easeOut(duration: 0.2)
    /// The "済" seal pressed on a slip: a short overshoot like a stamp landing.
    static let press: Animation = .spring(duration: 0.22, bounce: 0.35)
    /// How long the pressed seal stays visible before the list is read again (PWA: 350 ms).
    static let sealHold: Duration = .milliseconds(350)

    /// `standard` (or the given animation), or nil when Reduce Motion is on. Use with `.animation(_:value:)`.
    static func animation(_ reduceMotion: Bool, _ animation: Animation = standard) -> Animation? {
        reduceMotion ? nil : animation
    }

    /// Applies a state change with the animation, or without any animation when Reduce Motion is on.
    static func perform(_ reduceMotion: Bool, _ animation: Animation = standard, _ change: () -> Void) {
        if reduceMotion {
            var transaction = Transaction(); transaction.disablesAnimations = true
            withTransaction(transaction, change)
        } else {
            withAnimation(animation, change)
        }
    }
}

/// A placeholder band that slowly shines while AI fills the field (docs/DESIGN.md 読み取り中).
struct KMPendingBand: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    var body: some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(KMColor.sunken)
            .overlay {
                if !reduceMotion {
                    GeometryReader { geometry in
                        LinearGradient(colors: [KMColor.sunken, KMColor.surface, KMColor.sunken], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geometry.size.width)
                            .offset(x: phase * geometry.size.width)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .frame(height: 20)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1 }
            }
            .accessibilityHidden(true)
    }
}

/// The band of light that moves down the receipt photo while it is being read.
struct KMScanBand: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var progress: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            if reduceMotion {
                // A still tint says "being read" without movement.
                KMColor.primary.opacity(0.12)
            } else {
                let band = geometry.size.height * 0.35
                LinearGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: KMColor.primary.opacity(0.22), location: 0.8),
                    .init(color: KMColor.primary.opacity(0.7), location: 0.97),
                    .init(color: .clear, location: 1),
                ], startPoint: .top, endPoint: .bottom)
                    .frame(height: band)
                    .offset(y: -band + progress * (geometry.size.height + band))
            }
        }
        .allowsHitTesting(false)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: false)) { progress = 1 }
        }
        .accessibilityHidden(true)
    }
}

/// The mark at the start of a reading step: done, in progress, still to come, or failed.
struct KMStepMark: View {
    enum Phase { case done, now, todo, failed }
    let phase: Phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turning = false

    var body: some View {
        Group {
            switch phase {
            case .done:
                Text("✓").font(KMTypography.body(12, weight: .black)).foregroundStyle(KMColor.primary)
                    .frame(width: 22, height: 22).background(KMColor.primarySoft, in: Circle())
                    .transition(.scale(scale: 0.4).combined(with: .opacity))
            case .failed:
                Text("!").font(KMTypography.body(12, weight: .black)).foregroundStyle(KMColor.danger)
                    .frame(width: 22, height: 22).background(KMColor.dangerSoft, in: Circle())
            case .todo:
                Circle().strokeBorder(KMColor.borderStrong, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                    .frame(width: 22, height: 22)
            case .now:
                Circle().trim(from: 0, to: reduceMotion ? 1 : 0.75)
                    .stroke(KMColor.primary, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 20, height: 20)
                    .rotationEffect(.degrees(turning ? 360 : 0))
                    .frame(width: 22, height: 22)
                    .onAppear {
                        guard !reduceMotion else { return }
                        withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) { turning = true }
                    }
            }
        }
        .accessibilityHidden(true)
    }
}
