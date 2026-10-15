import type { LocalDataRepository } from '../../../src/lib/local-data';
import type { ManagedCategory } from '../../../src/lib/actual-browser-ledger';
import { foodConnections, grantFoodConnection, revokeFoodConnection } from './food-purchases-api';

export function initializeFoodConnectionsUi(repository: LocalDataRepository, listCategories: () => Promise<ManagedCategory[]>) {
  const host = document.querySelector<HTMLElement>('#food-connections-host')!;
  async function changeConnections<T>(change: () => T | Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error('このブラウザーでは連携設定を変更できません。対応ブラウザーでお試しください。');
    return await navigator.locks.request('kakeimatch.food-connections', change);
  }
  function message(value: string) { host.querySelector<HTMLElement>('[role=status]')!.textContent = value; }
  function render() {
    host.replaceChildren();
    const explanation = document.createElement('p');
    explanation.textContent = '許可したアプリに、選んだ食品カテゴリの購入品目・購入日・店名・数量・金額を渡します。口座・収入・写真は渡しません。この端末の接続画面を開いている間だけ利用できます。';
    host.append(explanation);
    const list = document.createElement('ul'); list.className = 'record-rows';
    const connections = foodConnections().filter(row => row.profileId === repository.profileId);
    for (const connection of connections) {
      const row = document.createElement('li'); row.className = 'record-row';
      const label = document.createElement('span'); label.className = 'record-main'; label.textContent = `${connection.name}（${connection.origin}）\n共有：${connection.categories.map(row => row.name).join('・')}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button destructive-text'; remove.textContent = '解除'; remove.setAttribute('aria-label', `${connection.name}との連携を解除`);
      remove.addEventListener('click', () => {
        remove.disabled = true;
        void changeConnections(() => revokeFoodConnection(connection.id)).then(() => {
          render(); message('連携を解除しました。新しい取得はできません。すでに渡したデータは連携先で管理してください。');
        }).catch(() => { remove.disabled = false; message('連携設定を保存できませんでした。もう一度お試しください。'); });
      });
      row.append(label, remove); list.append(row);
    }
    host.append(list);
    const add = document.createElement('details'); add.open = connections.length === 0;
    const addSummary = document.createElement('summary'); addSummary.textContent = '連携先を追加'; add.append(addSummary);
    const form = document.createElement('form'); form.className = 'settings-stack'; add.append(form);
    function field(labelText: string, name: string) {
      const label = document.createElement('label'); label.textContent = labelText;
      const input = document.createElement('input'); input.name = name; input.required = true; input.maxLength = name === 'name' ? 80 : 2000; label.append(input); form.append(label); return input;
    }
    const name = field('連携先の名前', 'name');
    const origin = field('連携先のサイトURL', 'origin'); origin.type = 'url'; origin.placeholder = 'https://example.com';
    const choose = document.createElement('details');
    const chooseSummary = document.createElement('summary'); chooseSummary.textContent = '共有するカテゴリを選ぶ'; choose.append(chooseSummary);
    const categoryArea = document.createElement('fieldset'); categoryArea.className = 'food-category-options'; const legend = document.createElement('legend'); legend.textContent = '食品として共有するカテゴリ'; categoryArea.append(legend);
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = '選んだカテゴリの品目だけを共有します。食品以外のカテゴリは選ばないでください。品目のない記録・未登録のレシートは共有しません。'; categoryArea.append(note); choose.append(categoryArea); form.append(choose);
    categoryArea.addEventListener('change', () => {
      const labels = Array.from(categoryArea.querySelectorAll<HTMLInputElement>('input:checked')).map(input => input.dataset.label);
      chooseSummary.textContent = labels.length ? `共有：${labels.join('・')}` : '共有するカテゴリを選ぶ';
    });
    const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary'; submit.textContent = '食品情報の連携を許可'; submit.disabled = true; form.append(submit);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); host.append(add, status);
    void listCategories().then(categories => {
      if (!host.contains(categoryArea)) return;
      for (const category of categories.filter(row => !row.isIncome && !row.hidden)) {
        const label = document.createElement('label'); label.className = 'food-category-choice';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'category'; checkbox.value = category.id; checkbox.dataset.label = category.name;
        label.append(checkbox, document.createTextNode(category.name)); categoryArea.append(label);
      }
      submit.disabled = false;
    }).catch(() => { message('カテゴリを読み込めませんでした。設定を開き直してください。'); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const categories = Array.from(categoryArea.querySelectorAll<HTMLInputElement>('input:checked')).map(input => ({ id: input.value, name: input.dataset.label! }));
      if (!categories.length) { message('食品として共有するカテゴリを選んでください。'); return; }
      submit.disabled = true;
      void changeConnections(() => grantFoodConnection({ profileId: repository.profileId, name: name.value, origin: origin.value, categories })).then(({ token }) => {
        render();
        const label = document.createElement('label'); label.textContent = '連携キー（この画面で一度だけ表示）';
        const input = document.createElement('textarea'); input.readOnly = true; input.value = token; input.rows = 3; input.autocomplete = 'off'; label.append(input);
        const note = document.createElement('p'); note.textContent = 'このキーを連携先アプリに入力してください。URLや公開のチャットに貼らないでください。閉じると再表示できません。';
        host.insertBefore(label, host.querySelector('details')); host.insertBefore(note, host.querySelector('details'));
        message('連携を許可しました。');
      }).catch(error => { submit.disabled = false; message(error instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(error.message) ? error.message : '連携設定を保存できませんでした。'); });
    });
  }
  document.querySelector('[data-settings-page="settings-page-food"]')!.addEventListener('click', () => {
    try { render(); } catch { host.textContent = '連携設定を開けませんでした。保存状態を確認してください。'; }
  });
}
