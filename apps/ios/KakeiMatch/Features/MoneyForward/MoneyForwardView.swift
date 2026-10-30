import SwiftUI
import UniformTypeIdentifiers

struct KMMoneyForwardView: View {
    @Environment(\.repositories) private var repositories
    @State private var model = KMMoneyForwardModel()
    @State private var showingImporter = false
    @State private var historyExpanded = false
    @State private var issuesExpanded = false
    @State private var undoBatch: KMMoneyForwardBatch?
    let onBack: () -> Void

    var body: some View {
        ScrollView {
          VStack(alignment: .leading, spacing: KMSpacing.space3) {
            backButton
            Text("マネーフォワードから移行")
                .font(KMTypography.heading)
                .foregroundStyle(KMColor.text)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("moneyforward.title")
            Text(KMMoneyForwardPresentation.intro)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)

            if model.isLoading {
                ProgressView().tint(KMColor.primary).frame(maxWidth: .infinity).padding(.vertical, KMSpacing.space4)
            } else {
                switch model.phase {
                case .select: selectSection
                case .mapping: mappingSection
                case .preview: previewSection
                case .result: resultSection
                }
            }

            if model.isBusy {
                ProgressView().tint(KMColor.primary).frame(maxWidth: .infinity).padding(.vertical, KMSpacing.space2)
            }
            if let error = model.error {
                Text(error)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("moneyforward.error")
            }
            if let status = model.statusMessage {
                Text(status)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("moneyforward.status")
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("moneyforward.screen")
        .safeAreaInset(edge: .bottom, spacing: 0) { pinnedActions }
        .task {
            await model.load(repositories)
            #if DEBUG
            await model.loadScenarioIfNeeded(repositories)
            #endif
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.commaSeparatedText, .plainText],
            allowsMultipleSelection: false) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                do {
                    let data = try Data(contentsOf: url)
                    Task { await model.loadCSV(data: data, name: url.lastPathComponent, repositories: repositories) }
                } catch {
                    model.error = "ファイルを読み取れません。別のCSVを選んでください。"
                }
            case .failure:
                model.error = "ファイルを選択できませんでした。もう一度お試しください。"
            }
        }
        .confirmationDialog("この移行を取り消しますか？", isPresented: undoBinding, titleVisibility: .visible) {
            if let batch = undoBatch {
                Button("取り消す", role: .destructive) {
                    undoBatch = nil
                    Task { await model.undo(batch, repositories: repositories) }
                }
            }
            Button("キャンセル", role: .cancel) { undoBatch = nil }
        } message: {
            Text(KMMoneyForwardPresentation.undoConfirmation)
        }
    }

    private var undoBinding: Binding<Bool> {
        Binding(get: { undoBatch != nil }, set: { if !$0 { undoBatch = nil } })
    }

    private var backButton: some View {
        Button(action: onBack) {
            HStack(spacing: 2) {
                KMIcon(name: "chevronLeft", size: 20)
                Text("戻る")
            }
            .frame(minHeight: KMLayout.minimumHit)
        }
        .buttonStyle(KMButtonStyle(role: .text))
        .accessibilityLabel("バックアップと復元へ戻る")
        .accessibilityIdentifier("moneyforward.back")
    }

    private var selectSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space3) {
            Text("MoneyForward CSVを選択")
                .font(KMTypography.body(16))
                .foregroundStyle(KMColor.text)
            Button(action: chooseFile) {
                HStack(spacing: KMSpacing.space2) {
                    KMIcon(name: "upload", size: 20).foregroundStyle(KMColor.primary)
                    Text(model.selectedFileName ?? "CSVファイルを選択")
                        .font(KMTypography.body(16, weight: .medium))
                        .foregroundStyle(KMColor.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, KMSpacing.space3)
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.lg))
                .overlay(RoundedRectangle(cornerRadius: KMRadius.lg).stroke(KMColor.borderStrong, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(model.isBusy)
            .accessibilityLabel("MoneyForward CSVを選択")
            .accessibilityIdentifier("moneyforward-file")

            Text(KMMoneyForwardPresentation.selectNote)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)

            if let fatal = model.fatalResult {
                VStack(alignment: .leading, spacing: KMSpacing.space2) {
                    Text(KMMoneyForwardPresentation.fatalStatus)
                        .font(KMTypography.body(14, weight: .medium))
                        .foregroundStyle(KMColor.danger)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(KMMoneyForwardPresentation.fatalDetails(fatal).enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(KMTypography.note)
                            .foregroundStyle(KMColor.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, KMSpacing.space2)
                .accessibilityIdentifier("moneyforward.fatal")
            }

            historySection
        }
    }

    private var mappingSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space4) {
            groupTitle("カテゴリをまとめて変換")
            ForEach(model.categoryGroups) { group in
                categoryRow(group)
            }

            groupTitle("支払元・口座の対応")
            ForEach(model.accountSources, id: \.self) { source in
                accountRow(source)
            }
            Text(KMMoneyForwardPresentation.accountNote)
                .font(KMTypography.note)
                .foregroundStyle(KMColor.muted)
                .fixedSize(horizontal: false, vertical: true)

        }
    }

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space4) {
            if let summary = model.summary {
                groupTitle("取り込み前の確認")
                detailLines(summary.lines, prefix: "moneyforward.detail.")

                if !summary.similarRows.isEmpty {
                    groupTitle("似ている既存記録を確認")
                    Text(KMMoneyForwardPresentation.similarNote)
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(summary.similarRows, id: \.importedId) { item in
                        reviewRow(item)
                    }
                }

                ForEach(summary.readyRows.prefix(5), id: \.importedId) { item in
                    Text(KMMoneyForwardPresentation.previewLine(item, categories: model.categories,
                        accounts: model.accounts, mappings: model.mappings))
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, KMSpacing.space2)
                        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
                        .accessibilityIdentifier("moneyforward.preview.row.\(item.importedId)")
                }

                issuesDisclosure

                if let notice = summary.notice {
                    Text(notice)
                        .font(KMTypography.body(14))
                        .foregroundStyle(KMColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Toggle("この対応を今後も使用する", isOn: $model.rememberMappings)
                    .font(KMTypography.note)
                    .tint(KMColor.primary)
                    .accessibilityIdentifier("moneyforward.rememberMappings")
            }
        }
    }

    @ViewBuilder
    private var pinnedActions: some View {
        if !model.isLoading {
            VStack(spacing: KMSpacing.space1) {
                switch model.phase {
                case .mapping:
                    primaryButton("取り込み内容を確認する", id: "moneyforward.preview") {
                        Task { await model.preview(repositories) }
                    }
                    Button("別のCSVを選ぶ", action: selectAnotherCSV)
                        .buttonStyle(KMButtonStyle(role: .text))
                        .frame(maxWidth: .infinity, minHeight: KMLayout.minimumHit)
                        .accessibilityIdentifier("moneyforward.selectAnother")
                case .preview:
                    if let summary = model.summary, summary.canImport {
                        primaryButton(summary.importTitle, id: "moneyforward.import") {
                            Task { await model.confirm(repositories) }
                        }
                    }
                    Button("対応を変更する") { model.backToMapping() }
                        .buttonStyle(KMButtonStyle(role: .text))
                        .frame(maxWidth: .infinity, minHeight: KMLayout.minimumHit)
                        .accessibilityIdentifier("moneyforward.backToMapping")
                case .select, .result:
                    EmptyView()
                }
            }
            .padding(.horizontal, KMSpacing.space4)
            .padding(.top, KMSpacing.space2)
            .padding(.bottom, KMSpacing.space2)
            .background(KMColor.surface)
            .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        }
    }

    private var resultSection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space4) {
            groupTitle("取り込み結果")
            if let result = model.resultSummary {
                detailLines(result.lines, prefix: "moneyforward.result.")
            }
            historySection
            Button("別のCSVを選ぶ", action: selectAnotherCSV)
                .buttonStyle(KMButtonStyle(role: .secondary))
                .frame(maxWidth: .infinity, minHeight: KMLayout.minimumHit)
                .accessibilityIdentifier("moneyforward.selectAnother")
        }
    }

    private func categoryRow(_ group: KMMoneyForwardPresentation.CategoryGroup) -> some View {
        let label = KMMoneyForwardPresentation.categoryLabel(group)
        let identifier = KMMoneyForwardPresentation.stableIdentifier("category", group.key)
        let tag = model.categoryTags[group.key] ?? "unresolved"
        return VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(label)
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
            Picker(label, selection: categoryBinding(group.key)) {
                Text("選択してください").tag("unresolved")
                ForEach(model.categories.filter { !$0.hidden && $0.isIncome == (group.row.kind == .income) }, id: \.id) { category in
                    Text(category.name).tag(category.id)
                }
                Text("新規カテゴリとして作成").tag("new")
                Text("未分類で取り込む").tag("unclassified")
                Text("取り込まない").tag("exclude")
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, KMSpacing.space3)
            .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
            .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.borderStrong, lineWidth: 1))
            .foregroundStyle(KMColor.text)
            .accessibilityLabel("\(label)の変換先")
            .accessibilityIdentifier(identifier)

            if tag == "new" {
                TextField("新しいカテゴリ名", text: newCategoryBinding(group.key))
                    .textInputAutocapitalization(.never)
                    .font(KMTypography.body(16))
                    .foregroundStyle(KMColor.text)
                    .padding(.horizontal, KMSpacing.space3)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(KMColor.bg, in: RoundedRectangle(cornerRadius: KMRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.border, lineWidth: 1))
                    .accessibilityLabel("\(label)の新規カテゴリ名")
                    .accessibilityIdentifier(identifier + ".name")
            }
            if let reason = group.row.categoryNeedsReviewReason {
                Text(reason)
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if tag == "unresolved" {
                Button("AIで候補を確認") { Task { await model.suggestCategory(for: group.key) } }
                    .buttonStyle(KMButtonStyle(role: .text))
                    .frame(minHeight: KMLayout.minimumHit, alignment: .leading)
                    .disabled(model.isBusy)
                    .accessibilityIdentifier(identifier + ".suggest")
            }
        }
        .padding(.vertical, KMSpacing.space2)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("moneyforward.mapping.category")
    }

    private func accountRow(_ source: String) -> some View {
        let label = KMMoneyForwardPresentation.accountLabel(source)
        let identifier = KMMoneyForwardPresentation.stableIdentifier("account", source)
        let tag = model.accountTags[source] ?? "unset"
        return VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(label)
                .font(KMTypography.body(14))
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
            Picker(label, selection: accountBinding(source)) {
                ForEach(model.accounts.filter { !$0.closed }, id: \.id) { account in
                    Text(account.name).tag(account.id)
                }
                Text("新しい支払元として作成").tag("new")
                Text("未設定で取り込む").tag("unset")
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, KMSpacing.space3)
            .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
            .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.borderStrong, lineWidth: 1))
            .foregroundStyle(KMColor.text)
            .accessibilityLabel("\(label)の移行先")
            .accessibilityIdentifier(identifier)

            if tag == "new" {
                TextField("新しい支払元名", text: newAccountBinding(source))
                    .textInputAutocapitalization(.never)
                    .font(KMTypography.body(16))
                    .foregroundStyle(KMColor.text)
                    .padding(.horizontal, KMSpacing.space3)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(KMColor.bg, in: RoundedRectangle(cornerRadius: KMRadius.md))
                    .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.border, lineWidth: 1))
                    .accessibilityLabel("\(label)の新しい支払元名")
                    .accessibilityIdentifier(identifier + ".name")
            }
        }
        .padding(.vertical, KMSpacing.space2)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("moneyforward.mapping.account")
    }

    private func reviewRow(_ item: KMMoneyForwardPresentation.PreviewInput) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(KMMoneyForwardPresentation.similarLine(item))
                .font(KMTypography.note)
                .foregroundStyle(KMColor.text)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(item.candidates, id: \.id) { candidate in
                Text(KMMoneyForwardPresentation.candidateLine(candidate, accounts: model.accounts))
                    .font(KMTypography.note)
                    .foregroundStyle(KMColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Picker("この行の取り込み方法", selection: recordBinding(item.importedId)) {
                Text("統一するか選んでください").tag("")
                Text("別の記録として取り込む（両方残す）").tag("separate")
                ForEach(item.candidates, id: \.id) { candidate in
                    Text(KMMoneyForwardPresentation.candidateTitle(candidate, accounts: model.accounts)).tag(candidate.id)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, KMSpacing.space3)
            .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
            .overlay(RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.borderStrong, lineWidth: 1))
            .foregroundStyle(KMColor.text)
            .accessibilityLabel("CSV \(item.row.rowNumber)行の既存記録との扱い")
            .accessibilityIdentifier(KMMoneyForwardPresentation.stableIdentifier("review", item.importedId))
        }
        .padding(.vertical, KMSpacing.space2)
        .overlay(alignment: .bottom) { Rectangle().fill(KMColor.border).frame(height: 1) }
    }

    private var issuesDisclosure: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Button {
                issuesExpanded.toggle()
            } label: {
                HStack(spacing: KMSpacing.space2) {
                    KMIcon(name: issuesExpanded ? "chevronDown" : "chevronRight", size: 16)
                        .foregroundStyle(KMColor.muted)
                    Text("除外・エラー行の理由")
                        .font(KMTypography.body(15, weight: .medium))
                        .foregroundStyle(KMColor.primary)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("moneyforward.issues")

            if issuesExpanded, let parsed = model.parsed {
                ForEach(parsed.excludedRows, id: \.rowNumber) { row in
                    Text("\(row.rowNumber)行: \(KMMoneyForwardPresentation.exclusionReason(row.reason))")
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(parsed.rowErrors, id: \.rowNumber) { row in
                    Text("\(row.rowNumber)行: \(row.reason)")
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Button {
                historyExpanded.toggle()
            } label: {
                HStack(spacing: KMSpacing.space2) {
                    KMIcon(name: historyExpanded ? "chevronDown" : "chevronRight", size: 16)
                        .foregroundStyle(KMColor.muted)
                    Text("移行履歴・取り消し")
                        .font(KMTypography.body(15, weight: .medium))
                        .foregroundStyle(KMColor.primary)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("moneyforward.history")

            if historyExpanded {
                if model.history.isEmpty {
                    Text("移行履歴はありません。")
                        .font(KMTypography.note)
                        .foregroundStyle(KMColor.muted)
                } else {
                    ForEach(model.history) { batch in
                        VStack(alignment: .leading, spacing: KMSpacing.space2) {
                            Text(model.historyLabel(batch))
                                .font(KMTypography.body(14))
                                .foregroundStyle(KMColor.text)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("moneyforward.history.row.\(batch.id)")
                            if batch.status != .undone {
                                Button("この移行を取り消す") { undoBatch = batch }
                                    .buttonStyle(KMButtonStyle(role: .destructive))
                                    .frame(maxWidth: .infinity, minHeight: KMLayout.minimumHit, alignment: .leading)
                                    .accessibilityIdentifier("moneyforward.undo.\(batch.id)")
                            }
                        }
                        .padding(.vertical, KMSpacing.space2)
                        Rectangle().fill(KMColor.border).frame(height: 1)
                    }
                }
            }
        }
    }

    private func groupTitle(_ text: String) -> some View {
        Text(text)
            .font(KMTypography.body(16, weight: .bold))
            .foregroundStyle(KMColor.text)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }

    private func detailLines(_ lines: [KMMoneyForwardPresentation.Line], prefix: String) -> some View {
        VStack(spacing: 0) {
            ForEach(lines) { line in
                HStack(alignment: .firstTextBaseline, spacing: KMSpacing.space2) {
                    Text(line.label)
                        .font(KMTypography.body(14))
                        .foregroundStyle(KMColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: KMSpacing.space2)
                    Text(line.value)
                        .font(KMTypography.number(14))
                        .foregroundStyle(KMColor.text)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .frame(maxWidth: .infinity, minHeight: 36)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("\(prefix)\(line.key)")
                Rectangle().fill(KMColor.border).frame(height: 1)
            }
        }
    }

    private func primaryButton(_ title: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
        }
        .buttonStyle(KMButtonStyle(role: .primary))
        .disabled(model.isBusy)
        .accessibilityIdentifier(id)
    }

    private func categoryBinding(_ key: String) -> Binding<String> {
        Binding(get: { model.categoryTags[key] ?? "unresolved" },
            set: { model.setCategoryTag($0, for: key) })
    }

    private func newCategoryBinding(_ key: String) -> Binding<String> {
        Binding(get: { model.newCategoryNames[key] ?? "" },
            set: { model.setNewCategoryName($0, for: key) })
    }

    private func accountBinding(_ source: String) -> Binding<String> {
        Binding(get: { model.accountTags[source] ?? "unset" },
            set: { model.setAccountTag($0, for: source) })
    }

    private func newAccountBinding(_ source: String) -> Binding<String> {
        Binding(get: { model.newAccountNames[source] ?? "" },
            set: { model.setNewAccountName($0, for: source) })
    }

    private func recordBinding(_ importedId: String) -> Binding<String> {
        Binding(get: { model.recordTags[importedId] ?? "" },
            set: { tag in
                model.setRecordTag(tag, for: importedId)
                Task { await model.preview(repositories) }
            })
    }

    private func chooseFile() {
        model.error = nil
        showingImporter = true
    }

    private func selectAnotherCSV() {
        model.reset()
        #if DEBUG
        if let repositories, repositories.fixtureName != nil, KMMoneyForwardFixture.scenario == "sample" {
            Task { await model.loadCSV(data: Data(KMMoneyForwardFixture.csv.utf8), name: "synthetic.csv", repositories: repositories) }
            return
        }
        #endif
        showingImporter = true
    }
}

#Preview { KMFixturePreview("migration") { KMMoneyForwardView(onBack: {}) } }
