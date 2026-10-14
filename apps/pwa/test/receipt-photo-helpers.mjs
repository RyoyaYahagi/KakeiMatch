/** Synthetic photo only: never loads personal receipt fixtures. */
export async function syntheticReceiptPhoto(page) {
  return Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 400;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 300, 400);
    context.fillStyle = '#000'; context.font = '22px sans-serif'; context.fillText('Synthetic Shop', 20, 40); context.fillText('Total 1280', 20, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
}
export async function confirmReceiptPhoto(page) {
  await page.getByRole('heading', { name: '送信する写真を確認' }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'この写真で読み取る', exact: true }).click();
}
export async function reselectReceiptPhoto(page, buffer) {
  await page.getByRole('button', { name: '写真を選び直す', exact: true }).click();
  await page.locator('.receipt-ai-area input[type=file]').setInputFiles({ name: 'synthetic-reselected.png', mimeType: 'image/png', buffer: buffer ?? await syntheticReceiptPhoto(page) });
}
