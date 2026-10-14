import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';
import type { LocalDataRepository } from '../../../src/lib/local-data';
import type { ActualTransaction } from '../../../src/lib/actual-ledger';
import { confirmedPayrollSchema, payrollRecordSchema, type ConfirmedPayroll, type PayrollRecord } from '../../../workers/ai-gateway/src/payroll-schema';

type Ledger = Pick<ReturnType<typeof createActualBrowserLedger>, 'getTransactions' | 'listRecurringSchedules' | 'createTransaction' | 'getTransactionById' | 'listOpenAccounts' | 'listIncomeCategories'>;
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s・]/g, '');
export class LocalPayrollService {
  constructor(private repository: LocalDataRepository, private ledger: Ledger) {}
  async list(): Promise<PayrollRecord[]> {
    return (await this.repository.list('payroll-record')).map(row => payrollRecordSchema.parse(row.value));
  }
  async duplicates(value: ConfirmedPayroll, ownId?: string): Promise<{ transactions: ActualTransaction[]; scheduled: boolean; pending: boolean }> {
    const month = value.paymentDate.slice(0, 7);
    const [rows, schedules, records] = await Promise.all([
      this.ledger.getTransactions({ startDate: `${month}-01`, endDate: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10) }),
      this.ledger.listRecurringSchedules(), this.list(),
    ]);
    // Also warn for manual/recurring income in the same month with a changed amount.
    const matchesEmployer = (name: string | null) => normalized(name ?? '') === normalized(value.employerName);
    return { transactions: rows.filter(row => row.kind === 'income' && matchesEmployer(row.payeeName) &&
      row.importedId !== `kakeimatch:payroll:${ownId}`),
      scheduled: schedules.some(row => row.kind === 'income' && !row.completed && matchesEmployer(row.name) && row.startDate.slice(0, 7) <= month),
      pending: records.some(row => row.id !== ownId && row.status === 'pending' && row.confirmed.paymentDate.slice(0, 7) === month && matchesEmployer(row.confirmed.employerName)),
    };
  }
  async register(id: string, value: ConfirmedPayroll, categoryId: string, accountId: string, model: string, allowDuplicate = false): Promise<PayrollRecord> {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('この端末では安全に登録できません。');
    return navigator.locks.request('kakeimatch-payroll-register', async () => {
      const saved = await this.repository.get(`payroll:${id}`);
      let record: PayrollRecord;
      if (saved) {
        record = payrollRecordSchema.parse(saved.value);
        if (record.status === 'applied') return record;
        // A partial save retries only the original confirmed transaction.
      } else {
        const confirmed = confirmedPayrollSchema.parse(value);
        const duplicates = await this.duplicates(confirmed, id);
        if (!allowDuplicate && (duplicates.transactions.length || duplicates.scheduled || duplicates.pending)) throw new Error('同じ月の給与または定期給与があります。確認してから登録してください。');
        const [accounts, categories] = await Promise.all([this.ledger.listOpenAccounts(), this.ledger.listIncomeCategories()]);
        if (!accounts.some(row => row.id === accountId && row.accountType === 'bank')) throw new Error('入金先の銀行口座を選んでください。');
        if (!categories.some(row => row.id === categoryId)) throw new Error('収入カテゴリを選んでください。');
        const now = new Date().toISOString();
        record = payrollRecordSchema.parse({ id, confirmed, categoryId, accountId, extractionModel: model,
          promptVersion: 'payroll-v1', status: 'pending', actualTransactionId: null, createdAt: now, updatedAt: now });
        await this.save(record);
      }
      const transaction = await this.ledger.createTransaction({ kind: 'income', amountYen: record.confirmed.netPayYen,
        date: record.confirmed.paymentDate, payeeName: record.confirmed.employerName, categoryId: record.categoryId,
        accountId: record.accountId, memo: null, importedId: `kakeimatch:payroll:${record.id}` });
      record = { ...record, status: 'applied', actualTransactionId: transaction.id, updatedAt: new Date().toISOString() };
      await this.save(record);
      return record;
    });
  }
  private async save(record: PayrollRecord) {
    await this.repository.put({ id: `payroll:${record.id}`, kind: 'payroll-record', value: payrollRecordSchema.parse(record), updatedAt: record.updatedAt });
  }
}
