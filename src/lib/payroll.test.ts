import { describe, expect, it } from 'vitest';
import { confirmedPayrollSchema, emptyPayroll, payrollSchema, payrollMismatch } from '../../workers/ai-gateway/src/payroll-schema';

const synthetic = () => ({ ...emptyPayroll(), employerName: 'Synthetic Employer', paymentDate: '2026-10-25',
  grossPayYen: 320000, netPayYen: 250000, deductions: { ...emptyPayroll().deductions, totalYen: 70000 } });
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