import Foundation
import Observation
import PhotosUI

@MainActor @Observable
final class KMPayrollModel {
    var employerName = ""
    var paymentDate = ""
    var netPay = ""
    var categoryId = ""
    var accountId = ""
    var payType: KMPayrollRecord.Confirmed.PayType = .salary
    var payPeriod = ""
    var grossPay = ""
    var deductions = Dictionary(uniqueKeysWithValues: KMPayrollPresentation.deductionFields.map { ($0.key, "") })
    var allowances: [KMPayrollDraftAllowance] = []
    var categories: [KMCategory] = []
    var accounts: [KMAccount] = []
    var imageData: Data?
    var contentType = ""
    var masks: [CGRect] = []
    var firstMaskPoint: CGPoint?
    var reviewed = false
    var loading = true
    var reading = false
    var saving = false
    var saved = false
    var duplicateMessage: String?
    var error: String?
    var status: String?
    var extractionModel = "manual"
    var hasPendingRecord: Bool { pendingRecord != nil }
    #if DEBUG
    /// Screenshot fixture: render the read-but-not-confirmed form from the fixture's pending values.
    var isDraftPreview: Bool { ProcessInfo.processInfo.arguments.contains("-PayrollDraft") }
    #else
    var isDraftPreview: Bool { false }
    #endif
    /// PWA unchecks the confirmation box whenever a confirmed field changes.
    var reviewFingerprint: String {
        let deductionValues = KMPayrollPresentation.deductionFields.map { deductions[$0.key] ?? "" }.joined(separator: "\u{1F}")
        let allowanceValues = allowances.map { "\($0.name)\u{1F}\($0.amount)" }.joined(separator: "\u{1E}")
        return [employerName, paymentDate, netPay, categoryId, accountId, payType.rawValue, payPeriod, grossPay, deductionValues, allowanceValues]
            .joined(separator: "\u{1D}")
    }

    @ObservationIgnored private var repositories: KMRepositories?
    @ObservationIgnored private var pendingRecord: KMPayrollRecord?
    @ObservationIgnored private var api: KMWorkerAPI?
    @ObservationIgnored private var readTask: Task<Void, Never>?

    var image: UIImage? { imageData.flatMap(UIImage.init(data:)) }
    var hasPayrollWarnings: Bool {
        guard let record = pendingRecord else { return false }
        return KMPayrollPresentation.mismatch(record.confirmed) || !record.confirmed.warnings.isEmpty
    }
    var warningText: String? {
        guard let record = pendingRecord else { return nil }
        if KMPayrollPresentation.mismatch(record.confirmed) { return "△ 総支給額・控除合計・手取りが一致しません。印字された値を確認してください。" }
        if !record.confirmed.warnings.isEmpty { return "△ 読み取りに不確かな項目があります。各項目を確認してください。" }
        return nil
    }

    func load(_ repositories: KMRepositories?) async {
        guard loading else { return }
        self.repositories = repositories
        guard let repositories else {
            error = "家計簿を読み込めません。アプリを開き直してください。"
            loading = false
            return
        }
        do {
            let allCategories = try await repositories.categories.categories(includeHidden: false)
            categories = allCategories.filter(\.isIncome)
            accounts = try await repositories.accounts.accounts(asOf: KMDate(instant: repositories.referenceDate), includeClosed: false)
                .filter { $0.accountType == .bank }
            let records = try await repositories.payroll.payrollRecords()
            if let pending = records.first(where: { $0.status == .pending }) {
                #if DEBUG
                // Screenshot fixture: show the read-but-not-confirmed form that the PWA reference
                // screenshot captures instead of the retry state.
                if isDraftPreview {
                    populate(pending.confirmed, model: pending.extractionModel)
                    reviewed = true
                    status = "写真から読み取りました。内容を確認してください。"
                } else {
                    populate(pending)
                }
                #else
                populate(pending)
                #endif
            }
            if categoryId.isEmpty { categoryId = categories.first(where: { $0.name == "給与" })?.id ?? "" }
            if accountId.isEmpty, accounts.count == 1 { accountId = accounts[0].id }
            if paymentDate.isEmpty { paymentDate = KMDate(instant: repositories.referenceDate).rawValue }
        } catch {
            self.error = "給与明細を読み込めませんでした。\(error.localizedDescription)"
        }
        loading = false
    }

    func selectImage(_ data: Data, contentType: String) {
        imageData = data
        self.contentType = contentType
        masks = []
        firstMaskPoint = nil
        reviewed = false
        error = nil
        status = nil
    }

    func addMaskPoint(_ point: CGPoint) {
        guard firstMaskPoint == nil else {
            let first = firstMaskPoint!
            masks.append(CGRect(x: min(first.x, point.x), y: min(first.y, point.y),
                                width: abs(first.x - point.x), height: abs(first.y - point.y)))
            firstMaskPoint = nil
            status = "範囲を隠しました。ほかにも隠す場合は左上をタップしてください。"
            return
        }
        firstMaskPoint = point
        status = "隠す範囲の右下をタップしてください。"
    }

    func readImage() {
        guard !reading, let imageData else { return }
        guard reviewed, firstMaskPoint == nil else {
            error = "隠す範囲を確定し、個人情報を隠したことを確認してください。"
            return
        }
        reading = true
        error = nil
        status = "読み取り中です。"
        let source = imageData
        let sourceType = contentType
        let rectangles = masks
        readTask = Task {
            defer { reading = false; self.imageData = nil; masks = []; firstMaskPoint = nil }
            do {
                let masked = try KMMaskedPayrollImage.prepare(data: source, contentType: sourceType,
                                                              masks: rectangles, maskingConfirmed: true)
                let client: KMWorkerAPI
                if let api { client = api }
                else { client = try KMWorkerAPI(configuration: KMAPIConfiguration()); api = client }
                let result = try await client.readPayroll(image: masked, flowID: UUID())
                guard !Task.isCancelled else { return }
                guard result.extraction.documentKind == .paySlip else { throw KMAPIError.invalidResponse }
                populate(confirmed(result.extraction), model: result.model)
                pendingRecord = nil
                reviewed = false
                if KMPayrollPresentation.mismatch(confirmed(result.extraction)) {
                    status = "△ 総支給額・控除合計・手取りが一致しません。印字された値を確認してください。"
                } else if !result.extraction.warnings.isEmpty {
                    status = "△ 読み取りに不確かな項目があります。各項目を確認してください。"
                } else { status = "写真から読み取りました。内容を確認してください。" }
            } catch {
                guard !Task.isCancelled else { return }
                self.error = "給与明細を読み取れませんでした。写真は破棄しました。写真を選び直すか、手で入力してください。"
            }
        }
    }

    func save(allowDuplicate: Bool = false) async {
        guard !saving, !saved, let repositories else { return }
        error = nil
        duplicateMessage = nil
        let confirmed: KMPayrollRecord.Confirmed
        do {
            confirmed = try KMPayrollPresentation.validate(employer: employerName, paymentDate: paymentDate,
                netPay: netPay, grossPay: grossPay, period: payPeriod, payType: payType,
                deductions: deductions, allowances: allowances)
        } catch {
            self.error = "勤務先・支給日・整数の手取り額を確認してください。個人識別情報は入力できません。"
            return
        }
        guard reviewed else { error = "勤務先・支給日・手取りと内訳を確認してください。"; return }
        guard categories.contains(where: { $0.id == categoryId }), accounts.contains(where: { $0.id == accountId }) else {
            error = "銀行口座・収入カテゴリを選んでください。"
            return
        }

        let id = pendingRecord?.id ?? UUID().uuidString.lowercased()
        if pendingRecord == nil && !allowDuplicate {
            do {
                if try await hasDuplicate(confirmed, ownID: id, repositories: repositories) {
                    duplicateMessage = "△ この給与はすでに登録されている可能性があります。同じ月の給与・定期給与を確認してください。"
                    return
                }
            } catch { self.error = "処理できませんでした。入力を確認して、もう一度お試しください。"; return }
        }
        saving = true
        defer { saving = false }
        let timestamp = repositories.fixtureName == nil ? Date() : repositories.referenceDate
        let previousPending = pendingRecord
        let record = previousPending ?? KMPayrollRecord(id: id, actualTransactionId: nil, status: .pending, confirmed: confirmed,
            categoryId: categoryId, accountId: accountId, extractionModel: extractionModel,
            promptVersion: "payroll-v1", createdAt: timestamp, updatedAt: timestamp)
        let input = KMManualTransactionInput(kind: .income, amountYen: record.confirmed.netPayYen,
            date: record.confirmed.paymentDate, payeeName: record.confirmed.employerName,
            categoryId: record.categoryId, accountId: record.accountId, memo: nil,
            importedId: "kakeimatch:payroll:\(id)")
        pendingRecord = record
        do {
            let applied = try await repositories.payroll.registerPayrollRecord(record, income: input)
            guard let readback = try await repositories.payroll.payrollRecords().first(where: { $0.id == applied.id }),
                  readback == applied,
                  let transactionID = applied.actualTransactionId,
                  let transaction = try await repositories.transactions.transaction(id: transactionID),
                  transaction.amountYen == confirmed.netPayYen, transaction.kind == .income,
                  transaction.importedId == input.importedId else {
                throw KMDataError.invalidData("給与の登録結果を読み戻せませんでした。")
            }
            pendingRecord = applied
            saved = true
            status = "登録しました。"
        } catch {
            do {
                let persisted = try await repositories.payroll.payrollRecords().first(where: { $0.id == record.id })
                if let persisted, persisted.status == .applied { pendingRecord = persisted }
                else { pendingRecord = previousPending }
                self.error = previousPending == nil && persisted == nil
                    ? "登録できませんでした。銀行口座・収入カテゴリと重複の確認を見直してください。"
                    : "登録を完了できませんでした。内容を保持しています。「登録結果を確認する」で再試行してください。"
            } catch {
                pendingRecord = record
                self.error = "登録状態を確認できません。内容を保持しています。再試行してください。"
            }
        }
    }

    func cancel() {
        readTask?.cancel()
        readTask = nil
        imageData = nil
        masks = []
        firstMaskPoint = nil
    }

    private func hasDuplicate(_ value: KMPayrollRecord.Confirmed, ownID: String, repositories: KMRepositories) async throws -> Bool {
        let month = value.paymentDate.yearMonth
        let transactions = try await repositories.transactions.transactions(matching: KMTransactionQuery(
            kind: .income, startDate: month.firstDay, endDate: month.lastDay, limit: nil))
        let name = normalized(value.employerName)
        if transactions.contains(where: { normalized($0.payeeName ?? "") == name && $0.importedId != "kakeimatch:payroll:\(ownID)" }) { return true }
        let schedules = try await repositories.recurring.recurringTransactions()
        if schedules.contains(where: { $0.kind == .income && !$0.completed && normalized($0.name) == name && $0.startDate.yearMonth <= month }) { return true }
        return try await repositories.payroll.payrollRecords().contains {
            $0.id != ownID && $0.status == .pending && $0.confirmed.paymentDate.yearMonth == month && normalized($0.confirmed.employerName) == name
        }
    }

    private func normalized(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping.lowercased().filter { !$0.isWhitespace && $0 != "・" }
    }

    private func populate(_ record: KMPayrollRecord) {
        populate(record.confirmed, model: record.extractionModel)
        categoryId = record.categoryId
        accountId = record.accountId
        reviewed = true
        pendingRecord = record
    }

    private func populate(_ value: KMPayrollRecord.Confirmed, model: String) {
        employerName = value.employerName
        paymentDate = value.paymentDate.rawValue
        netPay = String(value.netPayYen)
        grossPay = value.grossPayYen.map(String.init) ?? ""
        payPeriod = value.payPeriod ?? ""
        payType = value.payType
        deductions = ["incomeTaxYen": value.deductions.incomeTaxYen, "residentTaxYen": value.deductions.residentTaxYen,
            "healthInsuranceYen": value.deductions.healthInsuranceYen, "pensionYen": value.deductions.pensionYen,
            "employmentInsuranceYen": value.deductions.employmentInsuranceYen, "otherYen": value.deductions.otherYen,
            "totalYen": value.deductions.totalYen].mapValues { $0.map(String.init) ?? "" }
        allowances = value.allowances.map { .init(name: $0.name, amount: $0.amountYen.map(String.init) ?? "") }
        extractionModel = model
    }

    private func confirmed(_ value: KMPayrollResponse.Extraction) -> KMPayrollRecord.Confirmed {
        .init(documentKind: .paySlip, employerName: value.employerName ?? "", paymentDate: value.paymentDate ?? KMDate(instant: Date()),
              payPeriod: value.payPeriod, payType: value.payType, grossPayYen: value.grossPayYen,
              netPayYen: value.netPayYen ?? 0, deductions: value.deductions, allowances: value.allowances, warnings: value.warnings)
    }
}
