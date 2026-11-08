// CLI のエラー種別。終了コードは種別ごとに固定する。
// UsageError = 1（使い方の誤り）、SnapshotError = 2（読めない・検証に失敗）。

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export class SnapshotError extends Error {
  constructor(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list.join('\n'));
    this.name = 'SnapshotError';
    this.messages = list;
  }
}
