import SwiftUI

/// Custom presentation preserves PWA bottom alignment, 24pt corners and 80pt dismissal.
/// Unlike .sheet, it does not rescale the underlying page or hide the bottom navigation.
struct KMBottomSheet<Content: View>: View {
    let title: String
    @Binding var isPresented: Bool
    @ViewBuilder var content: () -> Content
    @AccessibilityFocusState private var titleFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                KMColor.scrim.ignoresSafeArea()
                    .contentShape(Rectangle()).onTapGesture { isPresented = false }
                    .accessibilityHidden(true)
                VStack(spacing: 0) {
                    Capsule().fill(KMColor.borderStrong).frame(width: 40, height: 5)
                        .padding(.top, KMSpacing.space2).padding(.bottom, KMSpacing.space2)
                        .frame(maxWidth: .infinity).contentShape(Rectangle())
                        .gesture(dismissDrag).accessibilityHidden(true)
                    HStack(spacing: KMSpacing.space3) {
                        Text(title).font(KMTypography.body(20, weight: .bold))
                            .foregroundStyle(KMColor.text)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityFocused($titleFocused)
                        Spacer(minLength: 0)
                        Button { isPresented = false } label: {
                            KMIcon(name: "close", size: 20)
                                .frame(width: KMLayout.minimumHit, height: KMLayout.minimumHit)
                        }
                        .buttonStyle(.plain).foregroundStyle(KMColor.primary)
                        .accessibilityLabel("閉じる").accessibilityIdentifier("record-sheet.close")
                    }
                    .contentShape(Rectangle()).gesture(dismissDrag)
                    ScrollView {
                        content()
                            .padding(.bottom, KMSpacing.space6 + geometry.safeAreaInsets.bottom)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }
                .padding(.horizontal, KMSpacing.space4)
                .frame(maxWidth: KMLayout.contentMax)
                .frame(height: min(480 + geometry.safeAreaInsets.bottom, geometry.size.height - 48))
                .glassEffect(.regular.tint(KMColor.bg), in: UnevenRoundedRectangle(topLeadingRadius: KMRadius.sheet, topTrailingRadius: KMRadius.sheet))
                .accessibilityAddTraits(.isModal)
                .accessibilityIdentifier("record-sheet")
                .transition(.move(edge: .bottom))
            }
            .ignoresSafeArea(edges: .bottom)
            .onAppear { titleFocused = true }
            .onExitCommand { isPresented = false }
        }
    }

    private var dismissDrag: some Gesture {
        DragGesture().onEnded { value in
            if value.translation.height > 80 { isPresented = false }
        }
    }
}
