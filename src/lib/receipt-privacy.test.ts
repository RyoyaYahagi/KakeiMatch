import { describe, expect, it } from 'vitest';
import { isReceiptPrivateText, privateReceiptRegions, sanitizeReceiptExtraction } from './receipt-privacy';
import { validateReceiptExtraction } from './receipt-extraction';
import { barcodeRegions } from '../../apps/pwa/src/receipt-code-detection';

const receipt = { documentKind: 'receipt', merchant: '合成商店', purchasedDate: '2026-10-11', purchasedTime: '12:34',
  totalAmountYen: 1234, taxAmountYen: 112, items: [{ name: '合成パン', amountYen: 1234 }], warnings: [] };

describe('receipt privacy', () => {
  it.each(['氏名：合成 太郎', '電話 090-1234-5678', '住所：架空県合成市1-2-3', '会員ID: SYNTHETIC123',
    'カード番号 4111 1111 1111 1111', '口座番号 1234567', '**** **** **** 1234', 'Member ID: TEST123', 'customer name: Synthetic Person'])('detects synthetic private text: %s', text => {
    expect(isReceiptPrivateText(text)).toBe(true);
  });
  it.each(['合成商店', '2026-10-11 12:34', '合成パン ¥1,234', '合計 1234円', 'ポイント利用 -100円'])('preserves ledger facts: %s', text => {
    expect(isReceiptPrivateText(text)).toBe(false);
  });
  it('masks labeled lines and the value immediately below a bare label without masking prices', () => {
    const lines = ['合成商店', '会員ID:', 'SYNTHETIC123', '合成パン 1234円'].map((text, i) => ({ text, bbox: { x0: 10, x1: 200, y0: i * 30, y1: i * 30 + 20 } }));
    expect(privateReceiptRegions(lines).map(region => region.y)).toEqual([27, 57]);
  });
  it('removes identifiers from every stored prose field and rejects raw OCR extras', () => {
    const protectedReceipt = sanitizeReceiptExtraction(validateReceiptExtraction({ ...receipt,
      merchant: 'Customer name: Synthetic Person', items: [{ name: '会員番号 1234567', amountYen: 1234 }],
      adjustments: [{ label: '口座番号 1234567', amountYen: 0 }],
      warnings: [{ field: 'items', code: 'カード番号 4111111111111111', message: '電話 090-1234-5678を確認', index: 0 }],
    }));
    expect(protectedReceipt.items[0].name).toBe('非公開');
    expect(JSON.stringify(protectedReceipt)).not.toMatch(/1234567|4111111111111111|090-1234-5678|Synthetic Person/);
    expect(protectedReceipt.totalAmountYen).toBe(1234);
    expect(() => validateReceiptExtraction({ ...receipt, rawOcr: 'Synthetic private OCR' })).toThrow();
  });
  it('detects synthetic vertical barcode bars while leaving blank space untouched', () => {
    const width = 240, height = 100;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 25; y < 75; y++) for (let x = 40; x < 200; x++) if (Math.floor(x / 2) % 2 === 0) {
      const index = (y * width + x) * 4; pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
    }
    expect(barcodeRegions(pixels, width, height).some(region => region.x < 45 && region.x + region.width >= 200)).toBe(true);
    expect(barcodeRegions(new Uint8ClampedArray(width * height * 4).fill(255), width, height)).toEqual([]);
  });
});
