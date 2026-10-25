import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readPortableBackup } from './local-backup-format';

describe('iOS移行用の合成バックアップ', () => {
  it('PWAの読込検証を通り、レシート画像と明細CSV原本を各1件含む', async () => {
    const bytes = await readFile('test/fixtures/ios-migration/synthetic.kmb');
    const backup = await readPortableBackup(new Blob([bytes]));
    expect(backup.manifest.exportedAt).toBe('2026-10-14T03:30:00.000Z');
    expect(backup.actualBackup.byteLength).toBeGreaterThan(0);
    expect(backup.localData.blobs).toHaveLength(2);
    expect(backup.localData.blobs.map(blob => blob.ownerKind).sort()).toEqual(['receipt', 'statement-import']);
    const image = backup.localData.blobs.find(blob => blob.ownerKind === 'receipt')!;
    expect(image.contentType).toBe('image/png');
    expect(image.blob.size).toBeGreaterThan(1000);
    const csv = backup.localData.blobs.find(blob => blob.ownerKind === 'statement-import')!;
    expect(await csv.blob.text()).toContain('青空食堂');
    expect(backup.localData.records.filter(row => row.kind === 'statement-transaction')).toHaveLength(7);
    const fixture = JSON.parse(await readFile('test/fixtures/ios-migration/fixture.json', 'utf8'));
    // PWA stores manual entries in receipt-metadata too; only one has an image.
    expect(backup.localData.records.filter(row => row.kind === 'receipt-metadata')).toHaveLength(fixture.transactions.length + 1);
    expect(backup.manifest.missingRawArtifacts).toEqual([]);
  });
});
