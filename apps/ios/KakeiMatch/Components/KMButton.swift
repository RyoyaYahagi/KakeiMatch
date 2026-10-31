import SwiftUI

struct KMButtonStyle: ButtonStyle {
    enum Role { case primary, secondary, text, destructive }
    /// `full` is the form action width. `intrinsic` keeps PWA settings-panel buttons inline.
    enum Width { case full, intrinsic }
    let role: Role
    var width: Width = .full
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(KMTypography.body(role == .primary ? 17 : 16, weight: role == .text ? .medium : .bold))
            .frame(maxWidth: role == .primary && width == .full ? .infinity : nil,
                   minHeight: role == .primary ? (width == .full ? 52 : KMLayout.minimumHit) : KMLayout.minimumHit)
            .padding(.horizontal, role == .primary ? KMSpacing.space4 : KMSpacing.space2)
            .foregroundStyle(foreground)
            .background(background(pressed: configuration.isPressed))
            .clipShape(RoundedRectangle(cornerRadius: role == .primary ? KMRadius.lg : KMRadius.md))
            .offset(y: configuration.isPressed && role == .primary && enabled ? 1 : 0)
            .scaleEffect(configuration.isPressed && role == .primary && enabled ? 0.985 : 1)
            .opacity(!enabled && role != .primary ? 0.55 : 1)
    }

    private var foreground: Color {
        if !enabled && role == .primary { return KMColor.muted }
        return role == .primary ? KMColor.onPrimary : role == .destructive ? KMColor.danger : KMColor.primary
    }
    private func background(pressed: Bool) -> Color {
        if role == .primary { return !enabled ? KMColor.sunken : pressed ? KMColor.primaryPress : KMColor.primary }
        return pressed && enabled ? (role == .destructive ? KMColor.dangerSoft : KMColor.primarySoft) : .clear
    }
}
