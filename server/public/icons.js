// Web controls use one rounded, 24-unit outline family.
const paths = {
  share: 'M12 16V2m-4 4 4-4 4 4M7 9H4v13h16V9h-3',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  mic: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3ZM19 10v1a7 7 0 0 1-14 0v-1M12 18v4',
  user: 'M20 21a8 8 0 0 0-16 0M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  device: 'M8 2h8a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3ZM9 7h6M12 17h.01',
  apps: 'M5 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM15 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM5 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1ZM15 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z',
  assistant: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9ZM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7Z',
  'add-home': 'M4 3h16v18H4V3ZM8 12h8M12 8v8',
  gear: 'M9.7 3.3 10.2 2h3.6l.5 1.3.5 1.5 1.5.9 1.5-.3 1.4-.2 1.8 3.1-.9 1.1-1 1.2v1.8l1 1.2.9 1.1-1.8 3.1-1.4-.2-1.5-.3-1.5.9-.5 1.5-.5 1.3h-3.6l-.5-1.3-.5-1.5-1.5-.9-1.5.3-1.4.2L2.1 15l.9-1.1 1-1.2v-1.8L3 9.7l-.9-1.1L3.9 5.5l1.4.2 1.5.3 1.5-.9.5-1.5ZM15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z',
  filters: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  inbox: 'M4 4h16l2 10v6H2v-6L4 4ZM2 14h6l2 3h4l2-3h6',
  todo: 'M9 11l3 3 8-9M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9',
  box: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
  reminder: 'M12 8v4l3 2M21 13a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 3 1 5M21 3l2 2',
  work: 'M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 7h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM2 12a24 24 0 0 0 20 0M12 12v3',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 12h8M8 16h5',
  cloud: 'M7 18a5 5 0 1 1 1-9 7 7 0 0 1 13 3 3 3 0 0 1-1 6H7Z',
  check: 'm5 12 4 4L19 6',
  sd: 'M8 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6l4-4ZM9 4v5M13 4v5M17 4v5',
  batt0: 'M4 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM23 10v4',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5',
  power: 'M12 2v10M6 5a9 9 0 1 0 12 0',
  unsure: 'M9 9a3 3 0 1 1 5 2c-1 1-2 1-2 3M12 18h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  noise: 'M3 10v4M7 6v12M11 3v18M15 8v8M19 5v14M23 10v4',
  archive: 'M3 3h18v5H3V3ZM5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  unarchive: 'M3 3h18v5H3V3ZM5 8v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M12 17v-6m-3 3 3-3 3 3',
  redo: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6',
  pencil: 'm16 3 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15v6Z',
  play: 'm8 5 11 7-11 7V5Z',
  pause: 'M8 5v14M16 5v14',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  moon: 'M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z',
  monitor: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 22h8M12 18v4',
  bolt: 'M9 3h6M12 3v3M6 6h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3ZM8 11v2M16 11v2M9 17h6M1 11v5M23 11v5',
  plug: 'M8 2v5M16 2v5M6 7h12v5a6 6 0 0 1-12 0V7ZM12 18v4',
  wifi: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01',
  alert: 'm10 3-9 16a1 1 0 0 0 1 2h20a1 1 0 0 0 1-2L14 3a2 2 0 0 0-4 0ZM12 9v4M12 17h.01',
  log: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 8h8M8 12h8M8 16h5',
  close: 'm6 6 12 12M18 6 6 18',
  'sign-out': 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};
paths.cloudx = `${paths.cloud}M3 3l18 18`;
export function iconSVG(name, size = 16, title = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'px-icon'})) svg.setAttribute(key, value);
  if (title) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', title); }
  else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths[name] ?? paths.note);
  svg.append(path);
  return svg;
}

/** OpenBelt's mark (its tile with the slot cut out, from OpenBelt's brand/logo), in the text colour: where paperbot hands off to OpenBelt. */
export function openbeltMark(size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({viewBox: '0 0 32 32', width: size, height: size, class: 'ob-mark', 'aria-hidden': 'true'})) svg.setAttribute(key, value);
  const tile = document.createElementNS(ns, 'path');
  tile.setAttribute('fill', 'currentColor');
  tile.setAttribute('fill-rule', 'evenodd');
  tile.setAttribute('d', 'M7.04 0h17.92A7.04 7.04 0 0 1 32 7.04v17.92A7.04 7.04 0 0 1 24.96 32H7.04A7.04 7.04 0 0 1 0 24.96V7.04A7.04 7.04 0 0 1 7.04 0ZM6.08 6.08H25.92V25.92H6.08V19.31H19.31V12.69H6.08Z');
  svg.append(tile);
  return svg;
}

