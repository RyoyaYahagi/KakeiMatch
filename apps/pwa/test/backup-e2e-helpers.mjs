export async function waitForBackupExportReady(page) {
  await page.waitForFunction(() => {
    const section = document.querySelector('#backup-settings');
    return !section?.hasAttribute('inert')
      && section?.querySelector('[role="status"]')?.textContent === 'バックアップを生成しました。Filesなどへの保存を確認してください。';
  });
}
