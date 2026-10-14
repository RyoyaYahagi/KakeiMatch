import 'fake-indexeddb/auto';
import type { ActualTransaction, ManualTransactionInput } from './actual-ledger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDataRepository } from './local-data';
import { createPortableBackup, readPortableBackup } from './local-backup-format';
import { LocalPayrollService } from '../../apps/pwa/src/local-payroll';
import { confirmedPayrollSchema, emptyPayroll, payrollSchema, payrollMismatch } from '../../workers/ai-gateway/src/payroll-schema';

const synthetic = () => ({ ...emptyPayroll(), employerName: 'Synthetic Employer', paymentDate: '2026-10-25',
  grossPayYen: 320000, netPayYen: 250000, deductions: { ...emptyPayroll().deductions, totalYen: 70000 } });
const confirmed = () => confirmedPayrollSchema.parse(synthetic());
afterEach(() => vi.unstubAllGlobals());
describe('payroll extraction boundary', () => {
  it.each(['salary', 'bonus', 'other'] as const)('keeps printed values for %s, independent of property order', payType => {
    const value = { ...synthetic(), payType };
    expect(payrollSchema.parse(value).netPayYen).toBe(250000);
  });
  it('keeps absent fields null and does not overwrite a mismatched printed net pay', () => {
    const value = { ...synthetic(), netPayYen: 240000, grossPayYen: null };
    expect(payrollSchema.parse(value).grossPayYen).toBeNull();
    expect(payrollMismatch({ ...value, grossPayYen: 320000 })).toBe(true);
    expect(payrollSchema.parse(value).deductions.incomeTaxYen).toBeNull();
    expect(confirmedPayrollSchema.safeParse({ ...value, netPayYen: null }).success).toBe(false);
  });
  it.each(['not_pay_slip', 'unknown'] as const)('allows %s extraction but refuses registration', documentKind => {
    expect(payrollSchema.safeParse({ ...synthetic(), documentKind }).success).toBe(true);
    expect(confirmedPayrollSchema.safeParse({ ...synthetic(), documentKind }).success).toBe(false);
  });
  it.each([{ netPayYen: '250000' }, { paymentDate: '2026-02-30' }, { netPayYen: 1.5 }, { employeeId: 'synthetic' },
    { employerName: '社員番号 12345' }, { employerName: '1234 5678 9012' },
    { warnings: [{ field: null, code: 'uncertain', message: 'Synthetic employee name' }] },
    { allowances: [{ name: '口座番号 1234567', amountYen: 123 }] }])('rejects malformed/identifier-bearing results %j', patch => {
    expect(payrollSchema.safeParse({ ...synthetic(), ...patch }).success).toBe(false);
  });
});
function ledgerStub() {
  return { getTransactions: vi.fn(async (): Promise<ActualTransaction[]> => []), listRecurringSchedules: vi.fn(async () => []),
    listOpenAccounts: vi.fn(async () => [{ id: 'bank', name: 'Synthetic Bank', accountType: 'bank' as const }]),
    listIncomeCategories: vi.fn(async () => [{ id: 'salary', name: '給与' }]),
    getTransactionById: vi.fn(async () => null),
    createTransaction: vi.fn(async (input: ManualTransactionInput) => ({ id: 'transaction', kind: 'income' as const, amountYen: input.amountYen,
      date: '2026-10-25', payeeName: 'Synthetic Employer', categoryName: '給与', accountId: 'bank', cleared: false })),
  };
}
async function setup() {
  vi.stubGlobal('navigator', { locks: { request: async (_key: string, task: () => Promise<unknown>) => task() } });
  const repository = await LocalDataRepository.open(crypto.randomUUID());
  const ledger = ledgerStub(); const service = new LocalPayrollService(repository, ledger);
  return { repository, ledger, service };
}
describe('confirmed payroll registration and portable data', () => {
  it('writes exactly one net-pay income, no deductions, and exports only structured data', async () => {
    const { repository, ledger, service } = await setup();
    try {
      const id = crypto.randomUUID();
      const saved = await service.register(id, confirmed(), 'salary', 'bank', 'synthetic-model');
      await service.register(id, confirmed(), 'salary', 'bank', 'synthetic-model');
      expect(ledger.createTransaction).toHaveBeenCalledTimes(1);
      expect(ledger.createTransaction.mock.calls[0]).toEqual([{ kind: 'income', amountYen: 250000,
        date: '2026-10-25', payeeName: 'Synthetic Employer', categoryId: 'salary', accountId: 'bank', memo: null,
        importedId: `kakeimatch:payroll:${id}` }]);
      expect(saved.actualTransactionId).toBe('transaction');
      const data = await repository.serialize(); expect(data.blobs).toEqual([]);
      const backup = await createPortableBackup({ actualBackup: new Uint8Array([1]), localData: data });
      const restored = await readPortableBackup(backup);
      expect(restored.localData.records[0].value).toEqual(saved);
      const target = await LocalDataRepository.open(crypto.randomUUID());
      try { await target.restore(restored.localData); expect((await new LocalPayrollService(target, ledger).list())[0]).toEqual(saved); } finally { target.close(); }
    } finally { repository.close(); }
  });
  it('preserves a stable confirmed record after uncertain Actual writes', async () => {
    const { repository, ledger, service } = await setup();
    try {
      ledger.createTransaction.mockRejectedValueOnce(new Error('synthetic failure'));
      const id = crypto.randomUUID();
      await expect(service.register(id, confirmed(), 'salary', 'bank', 'synthetic-model')).rejects.toThrow();
      expect((await service.list())[0].status).toBe('pending');
      await service.register(id, { ...confirmed(), netPayYen: 99 }, 'other', 'other', 'other');
      expect(ledger.createTransaction.mock.calls[1][0]).toMatchObject({ amountYen: 250000, accountId: 'bank', importedId: `kakeimatch:payroll:${id}` });
    } finally { repository.close(); }
  });
  it('warns about same-month recurring/manual income with a different amount and requires override', async () => {
    const { repository, ledger, service } = await setup();
    try {
      ledger.getTransactions.mockResolvedValue([ { id: 'scheduled-transaction', kind: 'income', payeeName: 'Synthetic Employer', date: '2026-10-24', amountYen: 230000, categoryName: '給与', accountId: 'bank', cleared: false } ]);
      const found = await service.duplicates(confirmed()); expect(found.transactions).toHaveLength(1);
      await expect(service.register(crypto.randomUUID(), confirmed(), 'salary', 'bank', 'synthetic-model')).rejects.toThrow('同じ月');
      expect(ledger.createTransaction).not.toHaveBeenCalled();
      await service.register(crypto.randomUUID(), confirmed(), 'salary', 'bank', 'synthetic-model', true);
      expect(ledger.createTransaction).toHaveBeenCalledTimes(1);
    } finally { repository.close(); }
  });
  it('refuses nonbank destinations and invalid income categories before saving', async () => {
    const { repository, ledger, service } = await setup();
    try {
      await expect(service.register(crypto.randomUUID(), confirmed(), 'salary', 'cash', 'synthetic-model')).rejects.toThrow('銀行');
      expect(await service.list()).toEqual([]); expect(ledger.createTransaction).not.toHaveBeenCalled();
    } finally { repository.close(); }
  });
});
