// DOM construction and formatting helpers.
//
// Everything user-supplied reaches the DOM as a text node, never as HTML: a
// session title, a memory description, and a tool result are all arbitrary
// text read off disk, so `el` takes children as strings/nodes and never parses
// markup.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v; // only ever called with literals
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  add(node, children);
  return node;
}

function add(node, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) add(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

export const mount = (node, ...children) => {
  clear(node);
  add(node, children);
  return node;
};

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function relativeTime(value) {
  if (!value) return '—';
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(t)) return '—';
  const secs = (Date.now() - t) / 1000;
  if (secs < 60) return 'just now';
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d ago`;
  if (days < 365) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(typeof value === 'number' ? value : Date.parse(value));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const mins = ms / 60000;
  if (mins < 1) return '<1m';
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** Trim a model id down to what distinguishes it. */
export function shortModel(m) {
  if (!m) return '';
  return m
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-20\d{6}$/, '');
}

/**
 * Electron wraps anything thrown in an IPC handler as
 * "Error invoking remote method 'x': Error: real message". Strip that so the
 * user reads the sentence the handler actually wrote.
 */
export function cleanError(err) {
  const raw = typeof err === 'string' ? err : err?.message || String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Uncaught )?Error:\s*/, '');
}

export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind}` }, message);
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 260);
  }, kind === 'err' ? 7000 : 3600);
}

/**
 * One on-disk location with its actions. `Open` opens the containing folder in
 * Explorer, `Reveal` selects the item inside it, and `Copy` puts the absolute
 * path on the clipboard for pasting into a terminal.
 */
export function pathRow(label, target, opts = {}) {
  if (!target) return null;
  return el('div', { class: 'pathrow' },
    el('div', { class: 'pathrow-main' },
      el('div', { class: 'pathrow-label' },
        label,
        opts.note ? el('span', { class: 'faint', style: { fontWeight: '400' } }, opts.note) : null,
        opts.missing ? el('span', { class: 'badge badge-warn' }, 'missing') : null
      ),
      el('div', { class: 'pathrow-path mono', title: target }, target)
    ),
    el('div', { class: 'pathrow-actions' },
      el('button', {
        class: 'btn btn-sm',
        title: 'Open the containing folder in Explorer',
        onclick: (e) => { e.stopPropagation(); window.api.openFolder(target); },
      }, 'Open'),
      el('button', {
        class: 'btn btn-sm',
        title: 'Show this item selected inside its folder',
        onclick: (e) => { e.stopPropagation(); window.api.reveal(target); },
      }, 'Reveal'),
      el('button', {
        class: 'btn btn-sm',
        title: 'Copy the full path',
        onclick: async (e) => {
          e.stopPropagation();
          await window.api.copyText(target);
          toast('Path copied to clipboard.', 'ok');
        },
      }, 'Copy')
    )
  );
}

/** A compact Open/Reveal/Copy cluster for dense rows. */
export function pathActions(target, opts = {}) {
  if (!target) return null;
  const mk = (glyph, title, fn) =>
    el('button', {
      class: 'iconbtn',
      title,
      onclick: async (e) => { e.stopPropagation(); await fn(); },
    }, glyph);

  return el('div', { class: `rowacts${opts.always ? ' always' : ''}` },
    mk('⌂', 'Open the containing folder', () => window.api.openFolder(target)),
    mk('◎', 'Reveal in Explorer', () => window.api.reveal(target)),
    mk('⧉', 'Copy path', async () => {
      await window.api.copyText(target);
      toast('Path copied to clipboard.', 'ok');
    })
  );
}

export function emptyState(icon, title, body) {
  return el('div', { class: 'empty' },
    el('div', { class: 'big' }, icon),
    el('h3', {}, title),
    body ? el('p', {}, body) : null
  );
}
