import { z } from 'zod';

// Free text is confined to financial labels. Identifiers and arbitrary OCR prose
// have no field in either the extraction or the portable record.
export const payrollText = z.string().trim().min(1).max(120).refine(value =>
  !/(?:\d[\s-]*){7,}|マイナンバー|個人番号|社員番号|従業員番号|口座番号|生年月日|住所|氏名|https?:|@/i.test(value.normalize('NFKC')),
  '個人識別情報を含む値は保存できません。');
const yen = z.number().int().nonnegative().safe().nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const deductionLabels = {
  incomeTaxYen: '所得税', residentTaxYen: '住民税', healthInsuranceYen: '健康保険',
  pensionYen: '厚生年金', employmentInsuranceYen: '雇用保険', otherYen: 'その他控除', totalYen: '控除合計',
} as const;
export const payrollSchema = z.object({
  documentKind: z.enum(['pay_slip', 'not_pay_slip', 'unknown']),
  employerName: payrollText.nullable(), paymentDate: date.nullable(), payPeriod: payrollText.nullable(),
  payType: z.enum(['salary', 'bonus', 'other']), grossPayYen: yen, netPayYen: yen,
  deductions: z.object({ incomeTaxYen: yen, residentTaxYen: yen, healthInsuranceYen: yen,
    pensionYen: yen, employmentInsuranceYen: yen, otherYen: yen, totalYen: yen }).strict(),
  allowances: z.array(z.object({ name: payrollText, amountYen: yen }).strict()).max(30),
  warnings: z.array(z.object({ field: z.enum(['employerName', 'paymentDate', 'grossPayYen', 'netPayYen', 'deductions', 'allowances']).nullable(),
    code: z.enum(['unreadable', 'uncertain', 'amount_mismatch']) }).strict()).max(30),
}).strict();
export const payrollJsonSchema = z.toJSONSchema(payrollSchema, { unrepresentable: 'any' });
export type PayrollExtraction = z.infer<typeof payrollSchema>;
export const confirmedPayrollSchema = payrollSchema.extend({ documentKind: z.literal('pay_slip'),
  employerName: payrollText, paymentDate: date, netPayYen: z.number().int().positive().safe() });
export type ConfirmedPayroll = z.infer<typeof confirmedPayrollSchema>;
export const payrollRecordSchema = z.object({ id: z.string().uuid(), actualTransactionId: z.string().min(1).nullable(),
  status: z.enum(['pending', 'applied']), confirmed: confirmedPayrollSchema,
  categoryId: z.string().min(1), accountId: z.string().min(1),
  extractionModel: z.string().min(1).max(100), promptVersion: z.literal('payroll-v1'),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type PayrollRecord = z.infer<typeof payrollRecordSchema>;
export const emptyPayroll = (): PayrollExtraction => ({ documentKind: 'pay_slip', employerName: null, paymentDate: null,
  payPeriod: null, payType: 'salary', grossPayYen: null, netPayYen: null,
  deductions: { incomeTaxYen: null, residentTaxYen: null, healthInsuranceYen: null, pensionYen: null,
    employmentInsuranceYen: null, otherYen: null, totalYen: null }, allowances: [], warnings: [] });
export function payrollMismatch(value: PayrollExtraction): boolean {
  return value.grossPayYen !== null && value.netPayYen !== null && value.deductions.totalYen !== null &&
    value.grossPayYen - value.deductions.totalYen !== value.netPayYen;
}
