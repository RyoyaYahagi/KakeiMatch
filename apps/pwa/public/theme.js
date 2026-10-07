// A blocking, same-origin script applies the saved appearance before the first paint.
// Keep this outside the main bundle so startup does not wait for the household engine.
(() => {
  const key = 'kakeimatch-theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    let preference = 'system';
    try {
      const saved = localStorage.getItem(key);
      if (saved === 'light' || saved === 'dark') preference = saved;
    } catch {
      // When browser storage is unavailable, system appearance still works.
    }
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
      const dark = meta.dataset.theme === 'dark';
      meta.media = dark === (theme === 'dark') ? 'all' : 'not all';
    });
  }
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('kakeimatch-theme-change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      apply();
      window.dispatchEvent(new Event('kakeimatch-theme-change'));
    }
  });
})();
