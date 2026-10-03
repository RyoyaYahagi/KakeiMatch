import notices from '../../../THIRD_PARTY_NOTICES.md?raw';

export function renderOssLicenses(container: HTMLElement) {
  const name = document.createElement('h4');
  name.textContent = 'Actual Budget';
  const description = document.createElement('p');
  description.textContent = 'KakeiMatch は、家計簿機能の一部にオープンソースソフトウェア「Actual Budget」を利用しています。';
  const attribution = document.createElement('p');
  attribution.className = 'muted';
  attribution.textContent = 'MIT License / © James Long';
  const link = document.createElement('a');
  link.className = 'oss-project-link';
  link.href = 'https://github.com/actualbudget/actual';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'GitHub（外部サイト・新しいタブ）';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'ライセンス全文';
  const license = document.createElement('pre');
  license.className = 'oss-license-text';
  // Keep the distributed license identical to the repository notice.
  const licenseText = /```text\n([\s\S]*?)\n```/.exec(notices)?.[1];
  if (!licenseText) throw new Error('Actual Budget license text is missing');
  license.textContent = licenseText;
  details.append(summary, license);
  container.append(name, description, attribution, link, details);
}
