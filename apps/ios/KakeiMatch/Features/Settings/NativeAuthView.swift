import SwiftUI

/// Settings > 利用状況 screen.
///
/// The screen only reads cloud AI usage; household repositories are not
/// consulted, so an unavailable or unused AI quota never blocks local use.
struct KMNativeAuthView: View {
    let model: KMNativeAuthModel
    let onBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text(KMNativeAuthPresentation.pageTitle)
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("settings-page-ai-title")

            VStack(alignment: .leading, spacing: KMSpacing.space4) {
                usageCard
                if !model.isUnavailable {
                    Text(KMNativeAuthPresentation.usageLead)
                        .font(KMTypography.text)
                        .foregroundStyle(KMColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("usage-lead")
                }
                if model.showStoreKitSandboxSection {
                    StoreKitSandboxSection(model: model)
                }
            }
            .padding(.vertical, KMSpacing.space4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { rule }
            .overlay(alignment: .bottom) { rule }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("nativeAuth.screen")
        .task {
            await model.loadStoreKitSandboxIfNeeded()
        }
    }

    private var backButton: some View {
        Button(action: onBack) {
            HStack(spacing: 2) {
                KMIcon(name: "chevronLeft", size: 20)
                Text("設定")
            }
            .frame(minHeight: KMLayout.minimumHit)
        }
        .buttonStyle(KMButtonStyle(role: .text))
        .accessibilityLabel("設定へ戻る")
        .accessibilityIdentifier("settings.back")
    }

    private var usageCard: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(model.usageSummary)
                .font(KMTypography.body(16, weight: .bold))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("usage-summary")

            if let fraction = model.usageFraction {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(KMColor.surface)
                        Capsule()
                            .fill(KMColor.primary)
                            .frame(width: max(0, geometry.size.width * fraction))
                    }
                }
                .frame(height: 10)
                .accessibilityHidden(true)
                .accessibilityIdentifier("usage-meter")
            }

            Text(KMNativeAuthPresentation.usageExplanation)
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, KMSpacing.space4)
        .padding(.vertical, KMSpacing.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(KMColor.sunken, in: RoundedRectangle(cornerRadius: KMRadius.lg))
    }

    private var rule: some View { Rectangle().fill(KMColor.border).frame(height: 1) }
}
