import SwiftUI

/// Minimal Sandbox-only StoreKit purchase and restore UI shown inside
/// `KMNativeAuthView` only when `KM_STOREKIT_SANDBOX_UI` is enabled and the
/// app is running in a Sandbox/Xcode StoreKit environment.
struct StoreKitSandboxSection: View {
    let model: KMNativeAuthModel

    var body: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text("Sandbox 課金検証")
                .font(KMTypography.body(15, weight: .bold))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("storekit.sandbox.header")

            Text("Sandbox 環境専用の購入・復元テストです。")
                .font(KMTypography.body(13))
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)

            if model.storeKitProducts.isEmpty {
                Text("商品情報を読み込めませんでした。")
                    .font(KMTypography.body(14))
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("storekit.sandbox.empty")

                Button("商品を再読み込み") {
                    Task { await model.reloadStoreKitProducts() }
                }
                .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
                .disabled(model.storeKitBusy)
                .accessibilityLabel("Sandbox 商品を再読み込み")
                .accessibilityIdentifier("storekit.sandbox.reload")
            } else {
                ForEach(model.storeKitProducts) { product in
                    VStack(alignment: .leading, spacing: KMSpacing.space2) {
                        HStack(alignment: .firstTextBaseline, spacing: KMSpacing.space2) {
                            Text(product.displayName)
                                .font(KMTypography.body(15, weight: .bold))
                                .foregroundStyle(KMColor.text)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: KMSpacing.space2)
                            Text(product.displayPrice)
                                .font(KMTypography.body(15, weight: .bold))
                                .foregroundStyle(KMColor.text)
                        }

                        if !product.description.isEmpty {
                            Text(product.description)
                                .font(KMTypography.body(13))
                                .foregroundStyle(KMColor.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Button(model.storeKitBusy ? "処理中…" : "購入する") {
                            Task { await model.purchaseStoreKitProduct(id: product.id) }
                        }
                        .buttonStyle(KMButtonStyle(role: .primary))
                        .disabled(model.storeKitBusy)
                        .accessibilityLabel("\(product.displayName)をSandboxで購入")
                        .accessibilityIdentifier("storekit.sandbox.purchase.\(product.id)")
                    }
                    .padding(KMSpacing.space3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                }
            }

            Button(model.storeKitBusy ? "処理中…" : "購入を復元する") {
                Task { await model.restoreStoreKitPurchases() }
            }
            .buttonStyle(KMButtonStyle(role: .secondary, width: .intrinsic))
            .disabled(model.storeKitBusy)
            .accessibilityLabel("Sandboxの購入を復元する")
            .accessibilityIdentifier("storekit.sandbox.restore")

            if let status = model.storeKitStatusMessage {
                Text(status)
                    .font(KMTypography.body(13))
                    .foregroundStyle(KMColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("storekit.sandbox.status")
            }

            if let error = model.storeKitErrorMessage {
                Text(error)
                    .font(KMTypography.body(13))
                    .foregroundStyle(KMColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("storekit.sandbox.error")
            }
        }
        .padding(.horizontal, KMSpacing.space4)
        .padding(.vertical, KMSpacing.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(KMColor.sunken, in: RoundedRectangle(cornerRadius: KMRadius.lg))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("storekit.sandbox.section")
    }
}
