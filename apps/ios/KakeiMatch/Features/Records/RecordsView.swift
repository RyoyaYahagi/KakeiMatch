import SwiftUI

struct RecordsView: View {
    @Environment(\.repositories) private var repositories
    @State private var model = KMRecordsModel()
    @State private var pendingToDelete: KMReceipt?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error = model.error {
                KMBanner(status: .danger, title: "操作を完了できませんでした。", detail: error,
                    actionTitle: model.page == .list ? "もう一度読み込む" : nil,
                    action: model.page == .list ? { Task { await model.reload() } } : nil)
                    .padding(.bottom, KMSpacing.space3)
            }
            if model.deletion != nil {
                KMToast(message: "削除しました。10秒以内なら元に戻せます。", actionTitle: "元に戻す") {
                    Task { await model.undo() }
                }.padding(.bottom, KMSpacing.space3)
            } else if let message = model.message {
                Text(message).font(KMTypography.note).foregroundStyle(KMColor.muted)
                    .accessibilityIdentifier("records.message").padding(.vertical, KMSpacing.space2)
            }
            switch model.page {
            case .list: list
            case .search: KMRecordsSearchView(model: model)
            case .detail: KMRecordDetailView(model: model)
            case .pending: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("records.screen")
        .task { await model.configure(repositories) }
        .fullScreenCover(isPresented: Binding(get: { model.page == .pending }, set: { if !$0 { Task { await model.showList() } } })) {
            pendingDetail.background(KMColor.bg)
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name(KMAppSettingsPreferences.screenLockDidLockNotificationName))) { _ in
            pendingToDelete = nil
            if model.page == .pending { Task { await model.showList() } }
        }
        .confirmationDialog("「\(pendingToDelete.map(KMRecordsPresentation.pendingTitle) ?? "")」を削除しますか？このレシート画像と確認待ちの内容も削除されます。",
            isPresented: Binding(get: { pendingToDelete != nil }, set: { if !$0 { pendingToDelete = nil } }), titleVisibility: .visible) {
                if let receipt = pendingToDelete {
                    Button("削除", role: .destructive) { Task { await model.deletePending(receipt) } }
                }
                Button("キャンセル", role: .cancel) { pendingToDelete = nil }
            }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("記録").font(KMTypography.body(22, weight: .bold)).foregroundStyle(KMColor.text)
                Spacer()
                Button { Task { await model.showSearch() } } label: {
                    KMIcon(name: "search", size: 20).foregroundStyle(KMColor.text)
                        .frame(width: 44, height: 44).background(KMColor.surface, in: Circle())
                }
                .buttonStyle(.plain).accessibilityLabel("検索・絞り込み")
                .accessibilityIdentifier("records.search").disabled(model.busy)
            }
            .padding(.top, KMSpacing.space2).padding(.bottom, KMSpacing.space3)
            KMSegmentedControl(options: KMRecordsFilter.allCases.map { KMSegment(id: $0.rawValue, label: $0.label) },
                selection: Binding(get: { model.filter.rawValue }, set: { model.filter = KMRecordsFilter(rawValue: $0) ?? .all }), identifier: "records.filter")
                .disabled(model.busy)
                .onChange(of: model.filter) { _, _ in Task { await model.reload() } }
            // Account management is a separate screen. No dead link into the placeholder settings shell.
            if model.busy && !model.loaded { ProgressView("記録を読み込んでいます。").padding(.vertical, KMSpacing.space6) }
            if !model.pending.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    dayHeader("確認待ち \(model.pending.count)件", total: 0)
                    ForEach(model.pending) { receipt in pendingRow(receipt) }
                }.padding(.top, KMSpacing.space2)
            }
            VStack(spacing: KMSpacing.space2) {
                ForEach(model.days) { day in
                    VStack(spacing: 0) {
                        dayHeader(KMRecordsPresentation.dayLabel(day.date), total: day.balanceYen)
                        ForEach(day.records) { row in
                            KMRecordRow(record: KMRecordsPresentation.summary(row, accounts: model.accounts,
                                receipt: model.receipts.first { $0.registration.actualTransactionId == row.id },
                                filter: model.filter, needsReview: model.reviewIDs.contains(row.id)), identifier: "records.row.\(row.id)") {
                                    Task { await model.open(row) }
                                }
                                .disabled(model.busy)
                                .overlay(alignment: .bottom) {
                                    if row.id == day.records.last?.id { Rectangle().fill(KMColor.bg).frame(height: 1) }
                                }
                                .accessibilityAddTraits(.isButton)
                        }
                    }
                }
            }.padding(.top, KMSpacing.space2)
            if model.loaded && model.days.isEmpty && (model.filter != .all || model.pending.isEmpty) {
                Text(model.filter == .all ? "まだ記録がありません。" : "この種類の記録はありません。")
                    .font(KMTypography.text).foregroundStyle(KMColor.muted)
                    .padding(.vertical, KMSpacing.space6).accessibilityIdentifier("records.empty")
            }
        }
    }

    private func dayHeader(_ label: String, total: Int) -> some View {
        HStack(spacing: KMSpacing.space2) {
            Text(label).font(KMTypography.body(13, weight: .bold)).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            if total != 0 {
                Text(KMAmountFormatter.signed(total, kind: .expense)).font(KMTypography.number(13, weight: .bold))
            }
        }
        .foregroundStyle(KMColor.muted)
        .padding(.top, KMSpacing.space3).padding(.bottom, KMSpacing.space1)
        .frame(minHeight: 36)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private func pendingRow(_ receipt: KMReceipt) -> some View {
        HStack(spacing: KMSpacing.space2) {
            Button {
                model.selectedReceipt = receipt; model.page = .pending; model.message = nil
            } label: {
                HStack(spacing: KMSpacing.space3) {
                    KMIcon(name: "receipt", size: 20).foregroundStyle(KMColor.warning)
                        .frame(width: KMLayout.recordIcon, height: KMLayout.recordIcon).background(KMColor.warningSoft, in: Circle())
                    VStack(alignment: .leading, spacing: 0) {
                        Text(KMRecordsPresentation.pendingTitle(receipt)).font(KMTypography.body(16, weight: .medium)).foregroundStyle(KMColor.text).lineLimit(1)
                        Text("内容を確認して登録してください").font(KMTypography.note).foregroundStyle(KMColor.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text("確認する").foregroundStyle(KMColor.primary).font(KMTypography.body(16, weight: .bold))
                }.frame(minHeight: 60).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("records.pending.\(receipt.id)")
            if receipt.registration.status == .pending && receipt.registration.actualTransactionId == nil {
                Button("削除") { pendingToDelete = receipt }.buttonStyle(KMButtonStyle(role: .destructive))
                    .accessibilityLabel("削除: \(KMRecordsPresentation.pendingTitle(receipt))")
            }
        }.disabled(model.busy)
    }

    // Pending receipts reuse the same editor as the add menu.
    private var pendingDetail: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Button { Task { await model.showList() } } label: {
                HStack(spacing: 2) { KMIcon(name: "chevronLeft", size: 20); Text("記録一覧へ戻る") }
            }
                .buttonStyle(KMButtonStyle(role: .text)).accessibilityIdentifier("records.pendingBackButton")
            if let receipt = model.selectedReceipt {
                ReceiptView(receiptID: receipt.id, onSaved: { Task { await model.showList() } })
            }
        }
    }
}

#Preview { KMFixturePreview("reconciliation") { RecordsView() } }
