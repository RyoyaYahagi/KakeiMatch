export function initializeThemeSettings(): void {
  const select = document.querySelector<HTMLSelectElement>('#theme-preference')!;
  const row = document.querySelector<HTMLElement>('#theme-row-value')!;
  const status = document.querySelector<HTMLElement>('#theme-status')!;
  function refresh() {
    select.value = document.documentElement.dataset.themePreference ?? 'system';
    row.textContent = select.selectedOptions[0].textContent;
  }
  refresh();
  window.addEventListener('kakeimatch-theme-change', refresh);
  select.addEventListener('change', () => {
    try {
      localStorage.setItem('kakeimatch-theme', select.value);
      window.dispatchEvent(new Event('kakeimatch-theme-change'));
      status.textContent = '';
      status.classList.remove('error');
    } catch {
      refresh();
      status.textContent = '外観を保存できませんでした。ブラウザーの保存設定を確認して、もう一度選んでください。';
      status.classList.add('error');
    }
  });
}
