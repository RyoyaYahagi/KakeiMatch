import SwiftUI

struct ReconciliationReviewBody: View {
    let row: KMReconciliationPresentation.Pending
    let model: KMReconciliationModel
    let perform: (KMReconciliationModel.Action) -> Void
    let suspect: () -> Void
    @State private var transfer = false
    @State private var category = ""
    @State private var destination = ""
    @State private var excluded = false
    @State private var categorySheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if row.statement.kind == .refund {
                Text("返金の記録です。現在は自動処理できません。")
            } else {
                ForEach(row.candidates) { candidate in
                    VStack(alignment: .leading, spacing: 8) {
                        ReconciliationSlip(statement: row.statement, record: .init(
                            date: candidate.transaction.date, merchant: candidate.transaction.payeeName ?? "店名なし",
                            amount: abs(candidate.transaction.amountYen),
                            source: model.accounts.first { $0.id == candidate.transaction.accountId }?.name ?? "利用できない支払元",
                            sameDate: candidate.sameDate, sameAmount: candidate.sameAmount,
                            differsDate: !candidate.sameDate, differsAmount: !candidate.sameAmount))
                        Text("△ \(candidate.reason)").font(KMTypography.body(14, weight: .bold))
                            .foregroundStyle(KMColor.warning).padding(.vertical, 8).padding(.horizontal, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(KMColor.warningSoft, in: RoundedRectangle(cornerRadius: 12))
                        if !candidate.sameAmount {
                            Text("「同じ支出」にすると、記録を明細の金額（\(KMAmountFormatter.yen(row.statement.amountYen))）に合わせます。")
                                .font(KMTypography.note).foregroundStyle(KMColor.muted)
                        }
                        if !candidate.canConfirm {
                            Text("分割された記録の金額差は反映できません。別の候補を選ぶか、明細を確認してください。")
                        }
                        Button("同じ支出") { perform(.confirm(statement: row.id, receipt: candidate.receiptId)) }
                            .buttonStyle(KMButtonStyle(role: .primary)).disabled(!candidate.canConfirm)
                            .accessibilityIdentifier("reconciliation.confirmMatch.\(row.id).\(candidate.receiptId)")
                        Button("別の支出") { perform(.reject(statement: row.id, receipt: candidate.receiptId)) }
                            .buttonStyle(KMButtonStyle(role: .text)).frame(maxWidth: .infinity)
                            .accessibilityIdentifier("reconciliation.reject.\(row.id).\(candidate.receiptId)")
                    }.accessibilityElement(children: .contain).accessibilityIdentifier("reconciliation.candidate.\(candidate.receiptId)")
                }
                if !row.hasCandidates {
                    ReconciliationSlip(statement: row.statement)
                    Text("記録が見つかりません。支出・振替として登録するか、登録しないで確認を終えられます。")
                    HStack {
                        Text("取引の種類"); Spacer()
                        Picker("取引の種類", selection: $transfer) { Text("支出").tag(false); Text("振替").tag(true) }
                            .labelsHidden().accessibilityIdentifier("kind-\(row.id)")
                    }.frame(minHeight: 52)
                    if transfer {
                        HStack {
                            Text("振替先"); Spacer()
                            Picker("振替先", selection: $destination) {
                                Text("振替先を選択してください").tag("")
                                ForEach(model.accounts.filter { !$0.closed }) { account in Text(account.name).tag(account.id) }
                            }.labelsHidden().accessibilityIdentifier("destination-\(row.id)")
                        }.frame(minHeight: 52)
                    } else {
                        HStack {
                            Text("カテゴリ").font(KMTypography.note).foregroundStyle(KMColor.muted)
                            Text(model.categories.first { $0.id == category }?.name ?? "カテゴリを選択してください").lineLimit(1)
                            Spacer(minLength: 0)
                            Button("すべて ›") { categorySheet = true }.frame(minHeight: 44)
                                .accessibilityIdentifier("category-\(row.id)")
                        }
                        Toggle("支出の計算に含めない", isOn: $excluded)
                            .font(KMTypography.note).accessibilityIdentifier("excluded-\(row.id)")
                    }
                    Button(transfer ? "振替として登録" : "支出として登録") {
                        guard !transfer || !destination.isEmpty else { model.errorMessage = "振替先を選択してください。"; return }
                        perform(.register(statement: row.id, category: transfer ? nil : category,
                                          destination: transfer ? destination : nil, excluded: excluded))
                    }.buttonStyle(KMButtonStyle(role: .primary)).accessibilityIdentifier("reconciliation.register.\(row.id)")
                }
            }
            if let attention = model.attention.first(where: { $0.statementId == row.id }) {
                Text("確認の理由：\(attention.reasons.joined(separator: "・"))").font(KMTypography.note).foregroundStyle(KMColor.muted)
            }
            Button("不正利用？", action: suspect).buttonStyle(KMButtonStyle(role: .secondary))
                .accessibilityIdentifier("reconciliation.suspect.\(row.id)")
            Button("登録しない") { perform(.ignore(row.id)) }
                .buttonStyle(KMButtonStyle(role: .text)).frame(maxWidth: .infinity)
                .accessibilityIdentifier("reconciliation.ignore.\(row.id)")
        }.padding(.bottom, 16).foregroundStyle(KMColor.text)
            .onAppear {
                if category.isEmpty {
                    category = KMReconciliationPresentation.suggestedCategory(merchant: row.statement.merchant,
                        rules: model.categoryRules, categories: model.categories) ?? ""
                }
            }
            .fullScreenCover(isPresented: $categorySheet) {
                KMBottomSheet(title: "カテゴリ", isPresented: $categorySheet) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                        ForEach(model.categories) { value in
                            let visual = KMCategoryTone.visual(name: value.name, id: value.id)
                            Button { category = value.id; categorySheet = false } label: {
                                VStack(spacing: 4) {
                                    KMIcon(name: visual.icon, size: 22).foregroundStyle(visual.tone.foreground)
                                    Text(value.name).font(KMTypography.body(12)).lineLimit(2)
                                }.frame(maxWidth: .infinity, minHeight: 64)
                                    .background(category == value.id ? KMColor.primarySoft : KMColor.surface, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay { RoundedRectangle(cornerRadius: 10).stroke(category == value.id ? KMColor.primary : KMColor.border, lineWidth: category == value.id ? 2 : 1) }
                            }.buttonStyle(.plain).accessibilityAddTraits(category == value.id ? .isSelected : [])
                                .accessibilityIdentifier("reconciliation.category.\(value.id)")
                        }
                    }
                }.presentationBackground(.clear)
            }
    }
}

struct ReconciliationMatchedBody: View {
    let decision: KMReconciliationResolution
    let statement: KMStatementTransaction
    let model: KMReconciliationModel
    let undo: () -> Void
    private var receipt: KMReceipt? { model.receipts.first { $0.id == decision.receiptId } }
    private var record: ReconciliationSlip.Record? {
        if let value = receipt?.confirmedValue {
            return .init(date: value.purchasedDate, merchant: value.merchant, amount: value.totalAmountYen, source: "レシート")
        }
        if let value = decision.actualSnapshot {
            return .init(date: value.date, merchant: value.payeeName ?? "店名なし", amount: abs(value.amountYen),
                         source: model.accounts.first { $0.id == value.accountId }?.name ?? "保存済みの支払元",
                         differsAmount: decision.source == .user && abs(value.amountYen) != decision.statementAmountYen)
        }
        return nil
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ReconciliationSlip(statement: statement, record: record, stamped: true)
            if record == nil { Text("対応する支出の詳細を端末で見つけられませんでした。").font(KMTypography.note) }
            Text(KMReconciliationPresentation.method(decision, receipt: receipt)).font(KMTypography.note).foregroundStyle(KMColor.muted)
            if KMReconciliationPresentation.canUndo(decision) {
                Button("一致を取り消す", action: undo).buttonStyle(KMButtonStyle(role: .secondary))
                    .accessibilityIdentifier("reconciliation.undo.\(statement.id)")
            } else if decision.source == .user {
                Text("以前の一致のため、取り消しはできません。").font(KMTypography.note).foregroundStyle(KMColor.muted)
            }
        }.padding(.bottom, 16)
    }
}

struct ReconciliationSlip: View {
    struct Record {
        var date: KMDate
        var merchant: String
        var amount: Int
        var source: String
        var sameDate = false
        var sameAmount = false
        var differsDate = false
        var differsAmount = false
    }
    let statement: KMStatementTransaction
    var record: Record?
    var stamped = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var body: some View {
        VStack(spacing: 0) {
            part(title: "カード明細", source: KMStatementDownload.label(statement.provider), date: statement.usedDate,
                 merchant: statement.merchant, amount: statement.amountYen)
            if let record {
                Rectangle().fill(KMColor.borderStrong).frame(height: 1)
                    .mask { HStack(spacing: 4) { ForEach(0..<40, id: \.self) { _ in Rectangle().frame(width: 4) } } }
                    .padding(.horizontal, 16)
                    .overlay(alignment: .leading) { Circle().fill(KMColor.bg).frame(width: 16, height: 16).offset(x: -8) }
                    .overlay(alignment: .trailing) { Circle().fill(KMColor.bg).frame(width: 16, height: 16).offset(x: 8) }
                part(title: "あなたの記録", source: record.source, date: record.date,
                     merchant: record.merchant, amount: record.amount,
                     sameDate: record.sameDate, sameAmount: record.sameAmount,
                     differsDate: record.differsDate, differsAmount: record.differsAmount)
            }
        }.background(KMColor.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay { RoundedRectangle(cornerRadius: 16).stroke(KMColor.border, lineWidth: 1) }
            .overlay(alignment: .trailing) {
                if stamped {
                    VStack(spacing: 0) { Text("済").font(KMTypography.body(22, weight: .black)); Text("照合").font(KMTypography.body(9)) }
                        .foregroundStyle(KMColor.success).frame(width: 60, height: 60)
                        .background(KMColor.surface.opacity(0.7), in: Circle()).overlay { Circle().stroke(KMColor.success, lineWidth: 3) }
                        .rotationEffect(.degrees(-14)).padding(.trailing, 16).accessibilityHidden(true)
                }
            }
    }
    private func part(title: String, source: String, date: KMDate, merchant: String, amount: Int,
                      sameDate: Bool = false, sameAmount: Bool = false, differsDate: Bool = false, differsAmount: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack { Text(title); Spacer(); Text(source) }.font(KMTypography.body(12)).foregroundStyle(KMColor.muted).padding(.bottom, 4)
            field("日付", value: KMReconciliationPresentation.shortDay(date), numeric: true, same: sameDate, differs: differsDate)
            field("店名", value: merchant)
            field("金額", value: KMAmountFormatter.yen(amount), numeric: true, same: sameAmount, differs: differsAmount)
        }.padding(.trailing, stamped ? 64 : 0).padding(.horizontal, 16).padding(.vertical, 12)
    }
    private func field(_ title: String, value: String, numeric: Bool = false, same: Bool = false, differs: Bool = false) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(KMTypography.note).foregroundStyle(KMColor.muted)
                    valueLine(value, numeric: numeric, same: same, differs: differs, size: title == "金額" ? 18 : 16)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(title).font(KMTypography.note).foregroundStyle(KMColor.muted).frame(width: 46, alignment: .leading)
                    valueLine(value, numeric: numeric, same: same, differs: differs, size: title == "金額" ? 18 : 16)
                }
            }
        }
    }

    private func valueLine(_ value: String, numeric: Bool, same: Bool, differs: Bool, size: CGFloat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(value).font(numeric ? KMTypography.number(size, weight: .bold) : KMTypography.body(16, weight: .medium))
                .foregroundStyle(differs ? KMColor.warning : KMColor.text)
                .padding(.horizontal, differs ? 8 : 0)
                .background(differs ? KMColor.warningSoft : .clear, in: RoundedRectangle(cornerRadius: 10))
            if same { Text("同じ").font(KMTypography.body(12)).foregroundStyle(KMColor.muted) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

}
