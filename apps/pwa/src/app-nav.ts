export function setNavActive(tab: HTMLElement, active: boolean) {
  tab.classList.toggle('active', active);
  tab.setAttribute('aria-pressed', String(active));
  if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
}
