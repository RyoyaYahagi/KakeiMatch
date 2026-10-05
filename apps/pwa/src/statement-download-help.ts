import type { StatementProvider } from './statement-parser';

type StatementDownloadHelp = { downloadUrl: string; note: string; importAvailable: boolean };

// Official destinations and instructions checked on 2026-10-04. Keep these
// fixed URLs free of KakeiMatch identifiers or card information.
export const STATEMENT_DOWNLOAD_HELP: Partial<Record<StatementProvider, StatementDownloadHelp>> = {
  // https://www.paypay-card.co.jp/service/000247.html
  paypay_card: {
    downloadUrl: 'https://www.paypay-card.co.jp/member/statement/top',
    note: '対象月を選び、「明細出力」→「CSVをダウンロードする」。',
    importAvailable: true,
  },
  // https://www.smbc-card.com/mem/oshiharai/meisai_about.jsp
  smbc_card: {
    downloadUrl: 'https://www.smbc-card.com/memapi/jaxrs/meisai/v1',
    note: 'PCのVpass Web明細で「CSV形式で保存する」を選択してください。',
    importAvailable: true,
  },
  // https://www.rakuten-card.co.jp/e-navi/p/rc/e-navi/statement/popup2.html
  rakuten_card: {
    downloadUrl: 'https://www.rakuten-card.co.jp/service/e-navi/list/',
    note: 'CSV取得はPC版楽天e-NAVIのみ対応しています。「ご利用明細」→「明細コピー用 Excel（CSV）」。',
    importAvailable: true,
  },
  // https://faq.aeon.co.jp/faq/show/226?site_domain=default
  aeon_card: {
    downloadUrl: 'https://www.aeon.co.jp/app/',
    note: '暮らしのマネーサイト / AEON Payから請求確定月のCSVを取得できます。',
    importAvailable: false,
  },
};
