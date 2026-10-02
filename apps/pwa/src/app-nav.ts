const NAV_ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  records: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  reconciliation: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
} as const;

export function navIcon(name: keyof typeof NAV_ICON_PATHS) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${NAV_ICON_PATHS[name]}</svg>`;
}

export function setNavActive(tab: HTMLElement, active: boolean) {
  tab.classList.toggle('active', active);
  tab.setAttribute('aria-pressed', String(active));
  if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
}
