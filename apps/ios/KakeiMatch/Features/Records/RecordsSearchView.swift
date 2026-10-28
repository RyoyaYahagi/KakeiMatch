import SwiftUI

struct KMRecordsSearchView: View {
    @Bindable var model: KMRecordsModel
    @State private var advanced = false
    @FocusState private var focused: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { focused = nil; Task { await model.showList() } } label: {
                HStack(spacing: 2) { KMIcon(name: "chevronLeft", size: 20); Text("記録") }
            }
            .buttonStyle(KMButtonStyle(role: .text)).accessibilityLabel("検索を閉じる")
            .accessibilityIdentifier("records.searchBack").padding(.bottom, KMSpacing.space2)
            Text("記録を検索").font(KMTypography.body(22, weight: .bold)).foregroundStyle(KMColor.text)
                .padding(.bottom, KMSpacing.space3)
            HStack(spacing: KMSpacing.space2) {
                KMIcon(name: "search", size: 20).foregroundStyle(KMColor.muted)
                TextField("店名・メモ・品目で検索", text: $model.search.keyword)
                    .accessibilityLabel("キーワード").accessibilityIdentifier("transaction-search-keyword")
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focused, equals: "keyword")
                    .submitLabel(.search).onSubmit { submit() }
            }
            .padding(.horizontal, KMSpacing.space3).frame(minHeight: 48)
            .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.lg))
            .overlay { RoundedRectangle(cornerRadius: KMRadius.lg).stroke(KMColor.primary, lineWidth: 2) }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: KMSpacing.space2) {
                    chip("期間", value: period, field: "start")
                    chip("種類", value: KMRecordsFilter(rawValue: model.appliedSearch.kind)?.label ?? "", field: "kind")
                    chip("カテゴリ", value: model.categories.first { $0.id == model.appliedSearch.categoryId }?.name ?? "", field: "category")
                }
                HStack(spacing: KMSpacing.space2) {
                    chip("口座", value: model.accounts.first { $0.id == model.appliedSearch.accountId }?.name ?? "", field: "account")
                    chip("金額", value: amountRange, field: "minimum")
                }
            }.padding(.top, KMSpacing.space3)
            Button { advanced.toggle(); focused = nil } label: {
                HStack(spacing: KMSpacing.space2) {
                    Text(advanced ? "▾" : "▸")
                    Text("詳細条件")
                }.frame(minHeight: 44)
            }
            .buttonStyle(.plain).foregroundStyle(KMColor.text).accessibilityIdentifier("records.advanced")
            .accessibilityValue(advanced ? "展開" : "折りたたみ").padding(.top, KMSpacing.space2)
            if advanced { fields }
            Button(model.busy ? "検索しています。" : "検索する") { submit() }
                .buttonStyle(KMButtonStyle(role: .secondary)).frame(maxWidth: .infinity, minHeight: 48)
                .accessibilityIdentifier("records.searchSubmit").padding(.top, KMSpacing.space5)
            Button { focused = nil; advanced = false; Task { await model.performSearch(clear: true) } } label: {
                HStack(spacing: KMSpacing.space1) { KMIcon(name: "close", size: 20); Text("条件をすべて解除") }
            }
            .buttonStyle(KMButtonStyle(role: .text)).accessibilityIdentifier("records.searchClear")
            .padding(.top, KMSpacing.space5)
            HStack {
                Text("\(model.searchRows.count)件").font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                    .accessibilityIdentifier("transaction-search-count")
                Spacer()
                if !model.searchRows.isEmpty && model.searchTotal != 0 {
                    Text(KMAmountFormatter.signed(model.searchTotal, kind: .expense)).font(KMTypography.number())
                        .accessibilityIdentifier("records.searchTotal")
                }
            }.padding(.horizontal, KMSpacing.space1).padding(.top, KMSpacing.space4).padding(.bottom, KMSpacing.space2)
            VStack(spacing: 0) {
                if model.searchRows.isEmpty && !model.busy && model.error == nil {
                    Text("条件に一致する記録はありません。").font(KMTypography.body(14)).foregroundStyle(KMColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, KMSpacing.space3)
                }
                ForEach(model.searchRows) { row in
                    KMRecordRow(record: KMRecordsPresentation.summary(row, accounts: model.accounts, receipt: nil, search: true),
                        identifier: "records.row.\(row.id)") { focused = nil; Task { await model.open(row) } }
                        .accessibilityAddTraits(.isButton)
                }
            }
            .overlay(alignment: .top) { Rectangle().fill(KMColor.border).frame(height: 1) }
        }
        .foregroundStyle(KMColor.text)
        .disabled(model.busy)
        .accessibilityElement(children: .contain).accessibilityIdentifier("records.searchScreen")
    }

    private var period: String {
        let draft = model.appliedSearch
        if draft.startDate.isEmpty && draft.endDate.isEmpty { return "" }
        return draft.startDate.dropFirst(5).replacingOccurrences(of: "-", with: "/") + "〜" + draft.endDate.dropFirst(5).replacingOccurrences(of: "-", with: "/")
    }
    private var amountRange: String {
        let draft = model.appliedSearch
        return draft.minimum.isEmpty && draft.maximum.isEmpty ? "" : draft.minimum + "〜" + draft.maximum + "円"
    }
    private func chip(_ label: String, value: String, field: String) -> some View {
        Button { advanced = true; focused = field } label: {
            HStack(spacing: KMSpacing.space1) {
                Text(value.isEmpty ? label : "\(label)：\(value)").lineLimit(1)
                KMIcon(name: "chevronDown", size: 14)
            }
            .font(KMTypography.body(14, weight: value.isEmpty ? .medium : .bold))
            .padding(.horizontal, KMSpacing.space4).frame(height: 36)
            .background(value.isEmpty ? KMColor.surface : KMColor.primarySoft, in: Capsule())
            .overlay { Capsule().stroke(value.isEmpty ? KMColor.borderStrong : KMColor.primary, lineWidth: value.isEmpty ? 1 : 2) }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(value.isEmpty ? KMColor.text : KMColor.primary)
        .accessibilityIdentifier("records.chip.\(field)").accessibilityAddTraits(value.isEmpty ? [] : .isSelected)
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text("金額は分割品目の金額ではなく、記録全体の金額です。").font(KMTypography.note).padding(.vertical, KMSpacing.space2)
            field("開始日", id: "start", text: $model.search.startDate, hint: "YYYY-MM-DD")
            field("終了日", id: "end", text: $model.search.endDate, hint: "YYYY-MM-DD")
            picker("種類", id: "kind", selection: $model.search.kind) {
                Text("すべて").tag("")
                ForEach(KMRecordsFilter.allCases.filter { $0 != .all }, id: \.rawValue) { Text($0.label).tag($0.rawValue) }
            }
            picker("カテゴリ（非表示を含む）", id: "category", selection: $model.search.categoryId) {
                Text("すべて").tag("")
                ForEach(model.categories) { Text($0.name + ($0.hidden ? " · 非表示" : "")).tag($0.id) }
            }
            picker("口座（利用終了を含む）", id: "account", selection: $model.search.accountId) {
                Text("すべて").tag("")
                ForEach(model.accounts) { Text($0.name + ($0.closed ? " · 利用終了" : "")).tag($0.id) }
            }
            field("金額の下限（円）", id: "minimum", text: $model.search.minimum, hint: "下限なし", numeric: true)
            field("金額の上限（円）", id: "maximum", text: $model.search.maximum, hint: "上限なし", numeric: true)
        }
    }

    private func field(_ label: String, id: String, text: Binding<String>, hint: String, numeric: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(label).font(KMTypography.text)
            TextField(hint, text: text).keyboardType(numeric ? .numberPad : .asciiCapable)
                .focused($focused, equals: id).accessibilityLabel(label).accessibilityIdentifier("records.search.\(id)")
                .padding(KMSpacing.space3).frame(minHeight: 48)
                .background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                .overlay { RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.borderStrong) }
        }.padding(.top, KMSpacing.space2)
    }

    private func picker<Options: View>(_ label: String, id: String, selection: Binding<String>, @ViewBuilder options: () -> Options) -> some View {
        VStack(alignment: .leading, spacing: KMSpacing.space2) {
            Text(label)
            Picker(label, selection: selection, content: options).labelsHidden().pickerStyle(.menu)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .padding(.horizontal, KMSpacing.space3).background(KMColor.surface, in: RoundedRectangle(cornerRadius: KMRadius.md))
                .overlay { RoundedRectangle(cornerRadius: KMRadius.md).stroke(KMColor.borderStrong) }
                .accessibilityIdentifier("records.search.\(id)")
        }.padding(.top, KMSpacing.space2)
    }

    private func submit() {
        focused = nil; advanced = false
        Task { await model.performSearch() }
    }
}
