import { LocalCategoryLearning, type LocalCategoryRule } from './local-category-learning';
import { backLink } from './settings-ui';
import type { createActualBrowserLedger } from '../../../src/lib/actual-browser-ledger';

type Ledger = ReturnType<typeof createActualBrowserLedger>;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className = '') {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}

/** The learned rules page is a settings subpage and stores its controls in local records only. */
export function initializeCategoryRulesUi(options: { entryContainer: HTMLElement; settingsContent: HTMLElement; ledger: Ledger; learning: LocalCategoryLearning }) {
  const page = node('section', undefined, 'master-settings category-rules-page');
  page.hidden = true;
  options.settingsContent.after(page);
  const status = node('p', '', 'master-status');
  status.setAttribute('role', 'status');
  let rows: LocalCategoryRule[] = [];

  const back = backLink('設定', '設定へ戻る', () => { page.hidden = true; options.settingsContent.hidden = false; });
  const title = node('h2', '分類ルール', 'page-title');
  const intro = node('p', '過去のレシートで確定した分類から、いつもの分類を自動で適用します。', 'muted');
  const list = node('section', undefined, 'surface-section settings-rows category-rule-list');
  const listTitle = node('h3', '自動で学習した分類', 'settings-group-title');
  const ul = node('ul'); list.append(ul);
  const reset = node('button', 'すべての変更をリセット', 'secondary');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    if (!window.confirm('分類ルールへの変更をすべてリセットしますか？学習履歴は残り、ルールは履歴から再計算されます。')) return;
    void (async () => {
      await options.learning.resetAllRuleOverrides();
      await refresh();
      status.textContent = '分類ルールへの変更をリセットしました。';
    })().catch(showError);
  });
  page.append(back, title, intro, status, listTitle, list, reset);

  const entry = node('button', '分類ルール', 'master-entry');
  entry.type = 'button';
  entry.setAttribute('aria-label', '分類ルール');
  entry.addEventListener('click', () => {
    options.settingsContent.hidden = true;
    page.hidden = false;
    status.textContent = '';
    void refresh().catch(showError);
  });
  options.entryContainer.append(entry);

  function showError(error: unknown) {
    status.textContent = error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message) ? error.message : '分類ルールを読み込めませんでした。端末内データを確認してください。';
    status.classList.add('error');
  }
  async function refresh() {
    const categories = await options.ledger.listExpenseCategories();
    rows = await options.learning.listRules(categories);
    ul.replaceChildren();
    if (rows.length === 0) {
      const empty = node('li', '分類ルールはまだありません。レシートを登録すると、履歴から自動で学習します。', 'empty muted');
      ul.append(empty);
      return;
    }
    for (const rule of rows) ul.append(ruleRow(rule, categories));
  }
  function ruleRow(rule: LocalCategoryRule, categories: Awaited<ReturnType<Ledger['listExpenseCategories']>>) {
    const item = node('li');
    const detail = node('details', undefined, `category-rule${rule.enabled ? '' : ' dimmed'}`);
    const summary = node('summary');
    summary.append(node('span', `${rule.normalizedName} → ${categories.find(category => category.id === rule.categoryId)?.name ?? '利用できないカテゴリ'}`, 'category-rule-title'));
    summary.append(node('span', rule.targetType === 'item' ? '品目' : '店舗', 'category-rule-kind'));
    detail.append(summary);

    const facts = node('p', `根拠: ${rule.matchingReceipts}件 / ${rule.receipts}件 · 一致率 ${rule.agreementPercent}%`, 'category-rule-facts');
    const statusLabel = node('label', undefined, 'category-rule-toggle');
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = rule.enabled; toggle.setAttribute('role', 'switch');
    const toggleText = node('span', rule.enabled ? '有効' : rule.deleted ? '削除済み' : '無効');
    statusLabel.append(toggle, toggleText);
    toggle.addEventListener('change', () => {
      toggle.disabled = true;
      void options.learning.setRuleOverride(rule, { disabled: !toggle.checked, deleted: false }).then(refresh).catch(showError).finally(() => { toggle.disabled = false; });
    });

    const categoryLabel = node('label', '適用カテゴリ');
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${rule.normalizedName}の適用カテゴリ`);
    select.replaceChildren(...categories.map(category => new Option(category.name, category.id)));
    select.value = rule.categoryId;
    categoryLabel.append(select);
    const save = node('button', 'カテゴリを変更', 'secondary'); save.type = 'button';
    save.disabled = true;
    const originalCategory = rule.categoryId;
    const updateSave = () => { save.disabled = !select.value || select.value === originalCategory; };
    select.addEventListener('change', updateSave);
    save.addEventListener('click', () => {
      save.disabled = true;
      void options.learning.setRuleOverride(rule, { categoryId: select.value, disabled: false, deleted: false }).then(async () => { status.textContent = '分類を変更しました。'; await refresh(); }).catch(showError);
    });
    const actions = node('div', undefined, 'category-rule-actions');
    actions.append(save);
    if (rule.deleted) {
      const undo = node('button', '削除を取り消す', 'text-button'); undo.type = 'button';
      undo.addEventListener('click', () => { void options.learning.resetRuleOverride(rule).then(refresh).catch(showError); });
      actions.append(undo);
    } else {
      const remove = node('button', '削除する', 'text-button destructive-text'); remove.type = 'button';
      remove.addEventListener('click', () => {
        if (!window.confirm(`「${rule.normalizedName}」の分類ルールを削除しますか？学習履歴は残り、このルールは自動で適用されなくなります。`)) return;
        void options.learning.setRuleOverride(rule, { deleted: true, disabled: false }).then(async () => { status.textContent = '分類ルールを削除しました。'; await refresh(); }).catch(showError);
      });
      actions.append(remove);
    }
    detail.append(facts, statusLabel, categoryLabel, actions);
    item.append(detail);
    return item;
  }
  return () => { page.hidden = true; options.settingsContent.hidden = false; };
}
