import type { ActualAccountType, createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';

type Account = Pick<Awaited<ReturnType<ReturnType<typeof createActualBrowserLedger>['listAccounts']>>[number], 'id' | 'name' | 'accountType'>;
export const accountTypeLabels = {
  bank: '銀行口座', credit_card: 'クレジットカード', cash: '現金', other: 'その他 / 未分類',
} as const;
export type AccountType = ActualAccountType;

export function accountTypeField(initial: AccountType = 'other') {
  const label = document.createElement('label'); label.textContent = '種類';
  const select = document.createElement('select'); select.name = 'accountType';
  select.id = `account-type-${crypto.randomUUID()}`; label.htmlFor = select.id;
  select.append(...Object.entries(accountTypeLabels).map(([type, name]) => new Option(name, type)));
  select.value = initial;
  return { label, select };
}

/** Groups native accounts without changing IDs or existing selections. */
export function accountOptions(accounts: Account[], kind: 'expense' | 'income' | 'transfer' = 'expense'): HTMLOptGroupElement[] {
  const order: AccountType[] = kind === 'expense' ? ['credit_card', 'bank', 'cash', 'other'] : ['bank', 'cash', 'other', 'credit_card'];
  return order.flatMap(type => {
    const rows = accounts.filter(account => account.accountType === type);
    if (!rows.length) return [];
    const group = document.createElement('optgroup'); group.label = accountTypeLabels[type];
    group.append(...rows.map(account => new Option(account.name, account.id)));
    return [group];
  });
}

export function accountBalanceLabel(type: AccountType, balanceYen: number) {
  const amount = `¥${Math.abs(balanceYen).toLocaleString('ja-JP')}`;
  if (type === 'credit_card') return balanceYen < 0 ? `差引未払額 ${amount}` : `差引預り額 ${amount}`;
  return `${balanceYen < 0 ? '−' : ''}${amount}`;
}
