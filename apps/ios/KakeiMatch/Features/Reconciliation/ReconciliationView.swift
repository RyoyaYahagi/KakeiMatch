import SwiftUI

struct ReconciliationView: View {
    @Environment(\.repositories) private var repositories
    @State private var model = KMReconciliationModel()
    @State private var importerExpanded = false
    @State private var matchedExpanded = false
    @State private var ignoredExpanded = false
    @State private var suspectedExpanded = false
    @State private var expandedRows: Set<String> = []
    @State private var confirmation: Confirmation?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Confirmation: Identifiable {
        let id = UUID()
        var title: String
        var message: String
        var action: KMReconciliationModel.Action
    }
    var body: some View {
        ScrollViewReader { scroll in
            VStack(alignment: .leading, spacing: KMSpacing.space3) {
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: KMSpacing.space2) {
                            Text("照合").font(KMTypography.body(22, weight: .bold)).foregroundStyle(KMColor.text)
                            rerunButton
                        }
                    } else {
                        HStack {
                            Text("照合").font(KMTypography.body(22, weight: .bold)).foregroundStyle(KMColor.text)
                            Spacer(minLength: 8)
                            rerunButton
                        }
                    }
                }
                if let error = model.errorMessage {
                    KMBanner(status: .danger, title: "照合情報を確認してください", detail: error,
                             actionTitle: "もう一度読み込む", action: { Task { await model.load(repositories) } })
                        .accessibilityIdentifier("reconciliation.error")
                }
                if let message = model.message { Text(message).font(KMTypography.note).accessibilityIdentifier("message") }
                if model.isLoading { ProgressView().frame(maxWidth: .infinity) }
                else if let run = model.run {
                    Text(model.runFeedback ?? "最終照合 \(KMReconciliationPresentation.timestamp(run.completedAt))。記録を追加・修正したら、もう一度照合すると新しい一致を探します。")
                        .font(KMTypography.note).foregroundStyle(KMColor.muted)
                        .lineSpacing(5).accessibilityIdentifier("reconciliation.runStatus")
                    failures
                    tiles(scroll)
                    attention(scroll)
                    if model.presentation.waiting > 0 {
                        Text("明細待ちの支出 \(model.presentation.waiting)件（明細を取り込むと照合します）")
                            .font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                    }
                    VStack(spacing: 0) {
                        Button { importerExpanded.toggle() } label: {
                            HStack(spacing: 8) { KMIcon(name: "upload", size: 20); Text("明細CSVを取り込む"); Spacer() }
                                .frame(minHeight: 44)
                        }.buttonStyle(KMButtonStyle(role: .secondary))
                            .accessibilityIdentifier("reconciliation.importCsvButton")
                            .accessibilityValue(importerExpanded ? "展開中" : "折りたたみ")
                        if importerExpanded { importer }
                    }.overlay(alignment: .top) { rule }.overlay(alignment: .bottom) { rule }
                        .padding(.vertical, 4)
                    pendingSection
                    histories
                } else {
                    Text("明細を取り込んでから照合してください。")
                        .foregroundStyle(KMColor.muted).font(KMTypography.body(14))
                    importer
                }
            }
            .disabled(model.isBusy)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain).accessibilityIdentifier("reconciliation.screen")
        }
        .task { await model.load(repositories) }
        .onChange(of: model.run?.runId) { _, _ in
            // PWA reviewPage redraws disclosures after each persisted decision/run.
            expandedRows = []; matchedExpanded = false; ignoredExpanded = false
            suspectedExpanded = false; importerExpanded = false
        }
        .alert(item: $confirmation) { value in
            Alert(title: Text(value.title), message: Text(value.message),
                  primaryButton: .default(Text(value.title)) { perform(value.action) }, secondaryButton: .cancel(Text("キャンセル")))
        }
    }
    private var rule: some View { Rectangle().fill(KMColor.border).frame(height: 1) }

    private var rerunButton: some View {
        Button { Task { await model.rerun(repositories) } } label: {
            HStack(spacing: 4) { KMIcon(name: "repeat", size: 18); Text("もう一度照合する") }
        }.buttonStyle(KMButtonStyle(role: .secondary))
            .accessibilityIdentifier("reconciliation.runAgain")
    }
    private var importer: some View {
        ReconciliationImporter(model: model, repositories: repositories)
    }
    private func perform(_ action: KMReconciliationModel.Action) {
        Task { await model.perform(action, repositories: repositories) }
    }
    private var failures: some View {
        ForEach(model.presentation.failures) { decision in
            KMBanner(status: .danger,
                title: decision.undoRequestedAt != nil ? "一致の取り消しが完了していません。判断内容は保存されています。" : "家計簿への反映が完了していません。判断内容は保存されています。",
                actionTitle: decision.undoRequestedAt != nil ? "取り消しを再試行する" : "反映を再試行する",
                action: { perform(.retry(decision)) })
        }
    }
    private func tiles(_ scroll: ScrollViewProxy) -> some View {
        let p = model.presentation
        return VStack(spacing: 1) {
            HStack(spacing: 1) {
                tile("要確認", count: p.needsReview, status: .warning) { revealPending(.needsReview, scroll) }
                tile("記録なし", count: p.unmatched, status: .missing) { revealPending(.unmatchedStatement, scroll) }
            }
            HStack(spacing: 1) {
                tile("一致", count: p.matched.count, status: .success) { matchedExpanded = true; scroll.scrollTo("reconciliation-matched", anchor: .top) }
                tile("不正利用？", count: p.suspected.count, status: .warning) { suspectedExpanded = true; scroll.scrollTo("reconciliation-suspected", anchor: .top) }
            }
        }.background(KMColor.border)
            .clipShape(RoundedRectangle(cornerRadius: KMRadius.lg))
            .overlay { RoundedRectangle(cornerRadius: KMRadius.lg).stroke(KMColor.border, lineWidth: 1) }
            .accessibilityElement(children: .contain).accessibilityLabel(p.resultLabel)
            .accessibilityIdentifier("reconciliation.counts")
    }
    private func revealPending(_ status: KMReconciliationStatementResult.Status, _ scroll: ScrollViewProxy) {
        if let row = model.presentation.pending.first(where: { $0.status == status }) { scroll.scrollTo(row.id, anchor: .top) }
    }
    private func tile(_ label: String, count: Int, status: KMStatus, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) { KMIcon(name: status == .warning ? "warning" : status == .missing ? "unmatched" : "check", size: 16); Text(label).font(KMTypography.body(13, weight: .bold)) }
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text(String(count)).font(KMTypography.number(26, weight: .bold))
                        .contentTransition(.numericText(value: Double(count)))
                        .animation(KMMotion.animation(reduceMotion), value: count)
                    Text("件").font(KMTypography.body(14, weight: .medium))
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(status == .success ? KMColor.surface : status.background)
                .foregroundStyle(status.foreground)
        }.buttonStyle(.plain).accessibilityLabel("\(label) \(count)件")
            .accessibilityIdentifier("reconciliation.count.\(label)")
    }
    @ViewBuilder private func attention(_ scroll: ScrollViewProxy) -> some View {
        if !model.attention.isEmpty {
            let isOpen = model.attention.contains { !model.acknowledgedAttention.contains($0.key) }
            DisclosureGroup(isExpanded: Binding(get: { isOpen }, set: { expanded in
                model.acknowledgedAttention = expanded ? [] : Set(model.attention.map(\.key))
            })) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("少額決済などの確認パターンに該当しています。不正利用と判定したものではありません。心当たりや利用先を確認してください。")
                    ForEach(model.attention, id: \.statementId) { warning in
                        if let statement = model.statements.first(where: { $0.id == warning.statementId }) {
                            Button("\(KMReconciliationPresentation.shortDay(statement.usedDate)) · \(statement.merchant) · \(KMAmountFormatter.yen(statement.amountYen))を確認する") {
                                suspectedExpanded = true; expandedRows.insert(statement.id); scroll.scrollTo(statement.id, anchor: .top)
                            }.buttonStyle(KMButtonStyle(role: .text))
                        }
                    }
                    Button("注意文を確認した") { model.acknowledgedAttention = Set(model.attention.map(\.key)) }
                        .buttonStyle(KMButtonStyle(role: .text))
                }
            } label: { Text("△ 確認をおすすめする明細 \(model.attention.count)件").font(KMTypography.body(14, weight: .bold)) }
                .padding(12).background(KMColor.warningSoft, in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(KMColor.warning)
        }
    }
    @ViewBuilder private var pendingSection: some View {
        if !model.presentation.pending.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("確認してください").font(KMTypography.body(16, weight: .bold)).padding(.top, 12).padding(.bottom, 4)
                ForEach(model.presentation.pending) { row in
                    VStack(spacing: 0) {
                        rule
                        rowButton(statement: row.statement, note: row.reason, status: row.status == .needsReview ? .warning : .missing)
                        if expandedRows.contains(row.id) {
                            ReconciliationReviewBody(row: row, model: model, perform: perform, suspect: {
                                confirmation = Confirmation(title: "不正利用？", message: "心当たりがない利用としてマークしますか？不正利用と確定する操作ではありません。", action: .suspect(row.id))
                            })
                        }
                    }.id(row.id)
                }
                rule
            }.id("reconciliation-pending").accessibilityElement(children: .contain).accessibilityIdentifier("reconciliation-pending")
                // A decided statement leaves the list; the rows below close the gap instead of jumping.
                .animation(KMMotion.animation(reduceMotion), value: model.presentation.pending.map(\.id))
        } else if model.presentation.isClear {
            KMStatusLabel(status: .success, message: "確認が必要な明細はありません")
                .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(KMColor.successSoft, in: RoundedRectangle(cornerRadius: 16))
        }
    }
    private func rowButton(statement: KMStatementTransaction, note: String, status: KMStatus?, identifier: String? = nil) -> some View {
        Button { toggle(statement.id) } label: { ReconciliationSummaryRow(statement: statement, note: note, status: status) }
            .buttonStyle(.plain).accessibilityIdentifier(identifier ?? "review-statement-\(statement.id)")
            .accessibilityValue(expandedRows.contains(statement.id) ? "展開中" : "折りたたみ")
    }
    private func toggle(_ id: String) { if expandedRows.contains(id) { expandedRows.remove(id) } else { expandedRows.insert(id) } }
    private func historyHeader(_ title: String, expanded: Binding<Bool>, identifier: String, completed: Bool = false) -> some View {
        Button { expanded.wrappedValue.toggle() } label: {
            HStack(spacing: 8) {
                if completed { KMCompletedStamp() } else { KMIcon(name: identifier == "reconciliation-suspected" ? "warning" : "eyeOff", size: 20).foregroundStyle(KMColor.muted).frame(width: 26) }
                Text(title).font(KMTypography.body(16, weight: .medium)); Spacer(minLength: 0)
                KMIcon(name: "chevronDown", size: 20).rotationEffect(.degrees(expanded.wrappedValue ? 180 : 0))
                    .transaction { $0.animation = nil; $0.disablesAnimations = true }.foregroundStyle(KMColor.muted)
            }.frame(minHeight: 52).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(KMColor.primary)
            .overlay(alignment: .top) { rule }.accessibilityIdentifier(identifier)
            .accessibilityValue(expanded.wrappedValue ? "展開中" : "折りたたみ")
    }
    @ViewBuilder private var histories: some View {
        if !model.presentation.suspected.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                historyHeader("不正利用？の明細（\(model.presentation.suspected.count)件）", expanded: $suspectedExpanded, identifier: "reconciliation-suspected")
                if suspectedExpanded {
                    Text("あなたが心当たりのない利用としてマークした明細です。KakeiMatchは不正利用と断定しません。")
                        .font(KMTypography.note).foregroundStyle(KMColor.muted)
                    ForEach(model.presentation.suspected, id: \.statementId) { flag in
                        if let statement = model.statements.first(where: { $0.id == flag.statementId }) {
                            rule
                            rowButton(statement: statement, note: "不正利用？", status: .warning)
                            if expandedRows.contains(statement.id) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("明細：\(statement.usedDate.rawValue) · \(statement.merchant) · \(KMAmountFormatter.yen(statement.amountYen))")
                                    Text("カード：\(KMStatementDownload.label(statement.provider))")
                                    Text("マークした日時：\(KMReconciliationPresentation.timestamp(flag.markedAt))（日本時間）")
                                    Text("カード会社の公式アプリやカード裏面の連絡先から、利用内容を確認してください。")
                                    if let support = KMStatementDownload.support(statement.provider) {
                                        Link("カード会社の公式案内", destination: support).frame(minHeight: 44)
                                    }
                                    ForEach(["不正利用？を解除する", "自分の利用だった"], id: \.self) { title in
                                        Button(title) { perform(.clearSuspected(statement.id)) }.buttonStyle(KMButtonStyle(role: .secondary))
                                    }
                                    Text("解除すると要確認・記録なしに戻ります。既存の記録と照合するか、支出・振替として登録してください。")
                                        .font(KMTypography.note).foregroundStyle(KMColor.muted)
                                }.padding(.bottom, 16)
                            }
                        }
                    }
                }
            }.id("reconciliation-suspected")
        }
        if !model.presentation.ignored.isEmpty {
            VStack(spacing: 0) {
                historyHeader("登録しないと判断した明細（\(model.presentation.ignored.count)件）", expanded: $ignoredExpanded, identifier: "reconciliation.ignoredGroup")
                if ignoredExpanded {
                    ForEach(model.presentation.ignored) { decision in
                        if let statement = model.statements.first(where: { $0.id == decision.statementId }) {
                            rule; ReconciliationSummaryRow(statement: statement, note: "登録しない", status: nil)
                        }
                    }
                }
            }
        }
        if !model.presentation.matched.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                historyHeader("一致した内容を見る（\(model.presentation.matched.count)件）", expanded: $matchedExpanded, identifier: "reconciliation-matched", completed: true)
                if matchedExpanded {
                    ForEach(model.presentation.matched) { decision in
                        if let statement = model.statements.first(where: { $0.id == decision.statementId }) {
                            rule
                            rowButton(statement: statement, note: decision.source == .automatic ? "自動" : "手動", status: .success, identifier: "reconciliation.matchedItem.\(statement.id)")
                            if expandedRows.contains(statement.id) {
                                ReconciliationMatchedBody(decision: decision, statement: statement, model: model) {
                                    confirmation = Confirmation(title: "一致を取り消す", message: "一致を取り消しますか？一致時に変更した金額と照合状態を戻し、もう一度候補を確認できます。", action: .undo(decision.id))
                                }
                            }
                        }
                    }
                }
            }.id("reconciliation-matched")
        }
    }
}

struct ReconciliationSummaryRow: View {
    var statement: KMStatementTransaction
    var note: String
    var status: KMStatus?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: KMSpacing.space1) {
                    HStack(alignment: .top, spacing: 12) {
                        statusIcon
                        VStack(alignment: .leading, spacing: 2) {
                            Text(statement.merchant).font(KMTypography.body(16, weight: .medium)).foregroundStyle(KMColor.text).lineLimit(2)
                            noteText.lineLimit(2)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    KMAmount(yen: statement.amountYen, size: 16)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .padding(.vertical, KMSpacing.space2)
            } else {
                HStack(spacing: 12) {
                    statusIcon
                    VStack(alignment: .leading, spacing: 2) {
                        Text(statement.merchant).font(KMTypography.body(16, weight: .medium)).foregroundStyle(KMColor.text).lineLimit(1)
                        noteText.lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    KMAmount(yen: statement.amountYen, size: 16)
                }
            }
        }.frame(minHeight: 64).contentShape(Rectangle())
            .accessibilityElement(children: .combine)
    }

    private var statusIcon: some View {
        KMIcon(name: status == .warning ? "warning" : status == .success ? "check" : status == nil ? "eyeOff" : "unmatched", size: 22)
            .foregroundStyle(status?.foreground ?? KMColor.muted)
            .frame(width: 36, height: 36).background(status?.background ?? KMColor.sunken, in: Circle())
    }

    private var noteText: some View {
        // PWA's later .record-note CSS rule overrides the note tone.
        Text("\(KMReconciliationPresentation.shortDay(statement.usedDate)) · \(note)")
            .font(KMTypography.body(13, weight: .medium)).foregroundStyle(KMColor.muted)
    }
}
