/** Встроенные SVG-значки: не зависят от наличия шрифтов с эмодзи на школьном компьютере. */
const P: Record<string, string> = {
  play: '<path d="M7 5v14l11-7z" fill="currentColor"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
  step: '<path d="M6 5v14l9-7zM16 5h3v14h-3z" fill="currentColor"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  forward: '<path d="M4 6v12l8-6zM12 6v12l8-6z" fill="currentColor"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><circle cx="15" cy="15" r="1.5" fill="currentColor"/><circle cx="15" cy="9" r="1.5" fill="currentColor"/><circle cx="9" cy="15" r="1.5" fill="currentColor"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 4v16" stroke="currentColor" stroke-width="2"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  drop: '<path d="M12 3c-3 4.5-6 8-6 11.2A6 6 0 0 0 18 14.2C18 11 15 7.5 12 3z" fill="currentColor"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor"/>',
};

export function icon(name: keyof typeof P | string, size = 16): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="flex:none">${P[name] ?? ''}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}
