import SwiftUI

/// Custom presentation preserves PWA bottom alignment, 24pt corners and 80pt dismissal.
/// Present inside .fullScreenCover with a clear presentation background: UIKit owns
/// modal focus isolation, while this view owns the PWA geometry and dimming.
struct KMBottomSheet<Content: View>: View {
    let title: String
    @Binding var isPresented: Bool
    @ViewBuilder var content: () -> Content
    @AccessibilityFocusState private var titleFocused: Bool
    @State private var contentHeight: CGFloat = 360

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
                                .glassEffect(.regular, in: Circle())
                        }
                        .buttonStyle(.plain).foregroundStyle(KMColor.text)
                        .keyboardShortcut(.cancelAction)
                        .accessibilityLabel("閉じる").accessibilityIdentifier("record-sheet.close")
                    }
                    .contentShape(Rectangle()).gesture(dismissDrag)
                    .padding(.bottom, KMSpacing.space3)
                    ScrollView {
                        content()
                            .padding(.bottom, KMSpacing.space6 + geometry.safeAreaInsets.bottom)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }
                .padding(.horizontal, KMSpacing.space4)
                .frame(maxWidth: KMLayout.contentMax)
                // Grabber (21) + header hit target (44) + PWA header margin (12).
                .frame(height: min(contentHeight + 77, geometry.size.height - 48))
                .glassEffect(.regular.tint(KMColor.bg), in: UnevenRoundedRectangle(topLeadingRadius: KMRadius.sheet, topTrailingRadius: KMRadius.sheet))
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
                .accessibilityIdentifier("record-sheet")
                .transition(.move(edge: .bottom))
            }
            .ignoresSafeArea(edges: .bottom)
            .onAppear { titleFocused = true }
            .accessibilityAction(.escape) { isPresented = false }
        }
    }

    private var dismissDrag: some Gesture {
        DragGesture().onEnded { value in
            if value.translation.height > 80 { isPresented = false }
        }
    }
}
