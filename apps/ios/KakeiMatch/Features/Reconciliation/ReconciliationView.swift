import SwiftUI
import UniformTypeIdentifiers

struct ReconciliationView: View {
    var onCreateRecord: (KMEntryInitialValues) -> Void = { _ in }
    @Environment(\.repositories) private var repositories
    @State private var model = KMReconciliationModel()
    @State private var analysisExpanded = false
    @State private var exportingAnalysis = false
    @State private var analysisDocument: AnalysisDocument?
    @State private var analysisFilename = "reconciliation-analysis"
    private struct AnalysisDocument: FileDocument {
        static var readableContentTypes: [UTType] { [.json] }
        var data: Data
        init(data: Data) { self.data = data }
        init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
        func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
    }
    @State private var importerExpanded = false
    @State private var matchedExpanded = false
    @State private var ignoredExpanded = false
    @State private var suspectedExpanded = false
    @State private var expandedRows: Set<String> = []
    @State private var confirmation: Confirmation?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private struct Confirmation: Identifiable {
        let id = UUID()
        var title: String
        var message: String
        var action: KMReconciliationModel.Action
    }
    private var analyticsSection: some View {
        DisclosureGroup("照合の分析", isExpanded: $analysisExpanded) {
            VStack(alignment: .leading, spacing: KMSpacing.space2) {
                ForEach(KMReconciliationAnalytics.summarize(model.analysisRuns).lines, id: \.self) { Text($0).font(KMTypography.body(14)) }
                Text("1位の採用率は、人が「同じ支出」と判断して反映できた候補が対象です。自動一致や未確認は正解として数えません。候補なしは誤判定を意味しません。取り消した判断は採用率から除きます。反映の失敗率は判断の最新状態で集計し、再試行で成功したものと「登録しない」は失敗に数えません。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted)
                Text("履歴は端末内に保存します。匿名化版には店名・取引日・取引額・支払元名を含めません。差額・日付差・操作日時は含みます。詳細版には照合時点の内容を含めます。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted)
                Button("匿名化版を書き出す") { exportAnalysis(detailed: false) }.buttonStyle(KMButtonStyle(role: .secondary))
                    .accessibilityIdentifier("reconciliation.analysis.exportAnonymous")
                Button("詳細版を書き出す（店名・金額を含む）") { exportAnalysis(detailed: true) }.buttonStyle(KMButtonStyle(role: .secondary))
                    .accessibilityIdentifier("reconciliation.analysis.exportDetailed")
                Text("テスト再照合").font(KMTypography.body(16, weight: .bold))
                Text("判断済みの明細と照合済みの支出も対象にします。家計簿や通常の判断は変更しません。現在の記録・支払元設定・学習済み店名で再計算するため、当時の再現や正解率の測定ではありません。明細から作成した支出も候補に含まれます。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted)
                Button("テスト再照合する") { Task { await model.testReplay(repositories) } }
                    .buttonStyle(KMButtonStyle(role: .secondary)).accessibilityIdentifier("reconciliation.analysis.testReplay")
                if let latest = model.testRuns.max(by: { $0.completedAt < $1.completedAt }) {
                    Text("保存したテスト：\(model.testRuns.count)回。最新の対象明細\(latest.statementResults.count)件、候補\(latest.candidates.count)件。")
                        .font(KMTypography.body(14)).accessibilityIdentifier("reconciliation.analysis.testStatus")
                    Button("テストの匿名化版を書き出す") { exportAnalysis(detailed: false, test: true) }.buttonStyle(KMButtonStyle(role: .secondary))
                    Button("テストの詳細版を書き出す（店名・金額を含む）") { exportAnalysis(detailed: true, test: true) }.buttonStyle(KMButtonStyle(role: .secondary))
                } else { Text("テスト結果はまだありません。").font(KMTypography.note) }
            }.padding(.vertical, 8)
        }.accessibilityIdentifier("reconciliation.analytics")
    }
    private func exportAnalysis(detailed: Bool, test: Bool = false) {
        do {
            analysisDocument = AnalysisDocument(data: try KMReconciliationAnalytics.export(test ? model.testRuns : model.analysisRuns, detailed: detailed, at: Date(), test: test))
            analysisFilename = "reconciliation-\(test ? "test-" : "")analysis-\(detailed ? "detailed" : "anonymous")"
            exportingAnalysis = true
        } catch { model.message = "分析データを書き出せませんでした。もう一度お試しください。" }
    }

    var body: some View {
        ScrollViewReader { scroll in
            VStack(alignment: .leading, spacing: KMSpacing.space3) {
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: KMSpacing.space2) {
                            Text("照合").font(KMTypography.body(22, weight: .bold)).foregroundStyle(KMColor.text)
                            if model.run != nil { rerunButton }
                        }
                    } else {
                        HStack {
                            Text("照合").font(KMTypography.body(22, weight: .bold)).foregroundStyle(KMColor.text)
                            Spacer(minLength: 8)
                            if model.run != nil { rerunButton }
                        }
                    }
                }
                if let error = model.errorMessage {
                    KMBanner(status: .danger, title: "照合情報を確認してください", detail: error,
                             actionTitle: "もう一度読み込む", action: { Task { await model.load(repositories) } })
                        .accessibilityIdentifier("reconciliation.error")
                }
                if let message = model.message { Text(message).font(KMTypography.note).accessibilityIdentifier("message") }
                if !model.isLoading { analyticsSection }
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
        .fileExporter(isPresented: $exportingAnalysis, document: analysisDocument, contentType: .json, defaultFilename: analysisFilename) { result in
            if case .failure = result { model.message = "分析データを書き出せませんでした。もう一度お試しください。" }
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
        return VStack(spacing: 0) {
            tile("要確認", count: p.needsReview, status: .warning) { revealPending(.needsReview, scroll) }
            rule
            tile("記録なし", count: p.unmatched, status: .missing) { revealPending(.unmatchedStatement, scroll) }
            rule
            tile("一致", count: p.matched.count, status: .success) { matchedExpanded = true; scroll.scrollTo("reconciliation-matched", anchor: .top) }
            rule
            tile("不正利用？", count: p.suspected.count, status: .warning) { suspectedExpanded = true; scroll.scrollTo("reconciliation-suspected", anchor: .top) }
        }
            .accessibilityElement(children: .contain).accessibilityLabel(p.resultLabel)
            .accessibilityIdentifier("reconciliation.counts")
    }
    private func revealPending(_ status: KMReconciliationStatementResult.Status, _ scroll: ScrollViewProxy) {
        if let row = model.presentation.pending.first(where: { $0.status == status }) { scroll.scrollTo(row.id, anchor: .top) }
    }
    private func tile(_ label: String, count: Int, status: KMStatus, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: KMSpacing.space3) {
                KMIcon(name: status == .warning ? "warning" : status == .missing ? "unmatched" : "check", size: 18)
                    .foregroundStyle(reconciliationSummaryForeground(status))
                    .frame(width: 30, height: 30)
                    .background(reconciliationSummaryBackground(status), in: Circle())
                Text(label).font(KMTypography.body(15, weight: .medium)).foregroundStyle(KMColor.text)
                Spacer(minLength: 0)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(String(count)).font(KMTypography.number(21, weight: .bold))
                    Text("件").font(KMTypography.body(13, weight: .medium))
                }.foregroundStyle(reconciliationSummaryForeground(status))
                KMIcon(name: "chevronRight", size: 16).foregroundStyle(KMColor.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
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
                            }, createRecord: { statement in
                                let sourceAccount = model.accounts.filter { !$0.closed && $0.statementProvider == statement.provider }
                                let importedAccount = model.imports.first { $0.id == statement.importId }?.value.accountId
                                let accountId = importedAccount.flatMap { id in
                                    model.accounts.contains(where: { !$0.closed && $0.id == id }) ? id : nil
                                } ?? (sourceAccount.count == 1 ? sourceAccount[0].id : nil)
                                onCreateRecord(.init(amountYen: statement.amountYen, payee: statement.merchant,
                                    date: statement.usedDate, accountId: accountId))
                            })
                        }
                    }.id(row.id)
                }
                rule
            }.id("reconciliation-pending").accessibilityElement(children: .contain).accessibilityIdentifier("reconciliation-pending")
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

private func reconciliationSummaryForeground(_ status: KMStatus) -> Color {
    switch status {
    case .warning: KMColor.cUtil
    case .missing, .danger: KMColor.muted
    case .success: KMColor.cDaily
    }
}

private func reconciliationSummaryBackground(_ status: KMStatus) -> Color {
    switch status {
    case .warning: KMColor.cUtilSoft
    case .missing, .danger: KMColor.sunken
    case .success: KMColor.cDailySoft
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
            .foregroundStyle(status.map(reconciliationSummaryForeground) ?? KMColor.muted)
            .frame(width: 36, height: 36).background(status.map(reconciliationSummaryBackground) ?? KMColor.sunken, in: Circle())
    }

    private var noteText: some View {
        // PWA's later .record-note CSS rule overrides the note tone.
        Text("\(KMReconciliationPresentation.shortDay(statement.usedDate)) · \(note)")
            .font(KMTypography.body(13, weight: .medium)).foregroundStyle(KMColor.muted)
    }
}
