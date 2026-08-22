// The transcript drawer: the whole conversation, rendered.
//
// Tool calls collapse to one line by default -- a long session is mostly tool
// traffic, and expanding it all by default would bury the actual conversation.

import { el, mount, clear, formatBytes, formatNumber, formatDateTime, relativeTime, shortModel, toast, pathRow } from '../dom.js';
import { store, set } from '../state.js';

const overlay = () => document.getElementById('overlay');

export async function openTranscript(session) {
  set({ openSession: session.id });
  const box = overlay();
  box.hidden = false;

  const drawer = el('div', { class: 'drawer' });
  mount(box, drawer);

  box.onclick = (e) => {
    if (e.target === box) closeTranscript();
  };
  document.addEventListener('keydown', escHandler);

  renderShell(drawer, session, el('div', { class: 'pane-body' }, el('div', { class: 'empty' }, el('div', { class: 'big' }, '⟳'), el('h3', {}, 'Reading transcript…'))));

  try {
    const [entries, subagents] = await Promise.all([
      window.api.readTranscript(session.jsonlPath, store.showThinking),
      session.sidecarDir ? window.api.readSubagents(session.sidecarDir) : Promise.resolve([]),
    ]);
    renderShell(drawer, session, body(entries, subagents, session), entries);
  } catch (err) {
    renderShell(drawer, session, el('div', { class: 'pane-body' }, el('div', { class: 'empty' },
      el('div', { class: 'big' }, '⚠'), el('h3', {}, 'Could not read this transcript'), el('p', {}, err.message))));
  }
}

function escHandler(e) {
  if (e.key === 'Escape') closeTranscript();
}

export function closeTranscript() {
  const box = overlay();
  box.hidden = true;
  clear(box);
  document.removeEventListener('keydown', escHandler);
  set({ openSession: null });
}

function renderShell(drawer, s, bodyNode, entries = null) {
  const messages = s.counts.user + s.counts.assistant;
  const models = Object.keys(s.models).filter((m) => m && m !== '<synthetic>').map(shortModel);

  // Only offer the thinking toggle when this transcript actually stored
  // reasoning text. Claude Code normally records the signature alone, so
  // advertising a toggle that reveals nothing would just look broken.
  const hasThinkingText = entries
    ? entries.some((e) => e.blocks.some((b) => b.type === 'thinking'))
    : false;

  mount(drawer,
    el('div', { class: 'drawer-head' },
      el('div', { style: { minWidth: 0, flex: '1' } },
        el('h2', {}, s.title || s.firstPrompt?.slice(0, 80) || s.id.slice(0, 8)),
        el('div', { class: 'sub mono' },
          `${s.id}  ·  ${formatDateTime(s.firstTs)} → ${relativeTime(s.lastTs)}`),
        el('div', { class: 'row-facts', style: { marginTop: '6px' } },
          el('span', {}, el('b', {}, 'msgs'), ' ', formatNumber(messages)),
          el('span', {}, el('b', {}, 'tools'), ' ', formatNumber(s.counts.toolUse)),
          s.counts.thinking
            ? el('span', { title: 'Claude Code stores the signature of each thinking block but not its text, so these cannot be read back.' },
                el('b', {}, 'thinking'), ' ', formatNumber(s.counts.thinking), ' (not stored)')
            : null,
          el('span', {}, el('b', {}, 'out'), ' ', formatNumber(s.tokens.output), ' tok'),
          el('span', {}, el('b', {}, 'cache read'), ' ', formatNumber(s.tokens.cacheRead), ' tok'),
          el('span', {}, el('b', {}, 'size'), ' ', formatBytes(s.totalBytes)),
          models.length ? el('span', {}, el('b', {}, 'model'), ' ', models.join(', ')) : null,
          s.gitBranch ? el('span', {}, el('b', {}, 'branch'), ' ', s.gitBranch) : null
        )
      ),
      el('div', { class: 'actions', style: { display: 'flex', gap: '7px', flex: 'none' } },
        hasThinkingText
          ? el('label', { class: 'btn btn-sm btn-ghost', title: 'Show extended thinking blocks' },
              el('input', {
                type: 'checkbox',
                checked: store.showThinking,
                style: { marginRight: '6px' },
                onchange: (e) => {
                  store.showThinking = e.target.checked;
                  openTranscript(s);
                },
              }),
              'Thinking'
            )
          : null,
        el('button', {
          class: 'btn btn-sm',
          title: `Open the folder holding this transcript:
${s.jsonlPath}`,
          onclick: () => window.api.openFolder(s.jsonlPath),
        }, 'Open folder'),
        el('button', {
          class: 'btn btn-sm',
          title: 'Copy the transcript path',
          onclick: async () => { await window.api.copyText(s.jsonlPath); toast('Path copied to clipboard.', 'ok'); },
        }, 'Copy path'),
        el('button', { class: 'btn btn-sm', onclick: closeTranscript }, 'Close')
      )
    ),
    bodyNode
  );
}

/**
 * Every on-disk location this session owns, in one place -- the transcript,
 * its sidecar folder, its file-history and session-env entries, the project's
 * Claude data directory, and the working directory the session ran in.
 */
function locations(s) {
  const project = s.project || null;
  const rows = [
    pathRow('Transcript', s.jsonlPath, { note: formatBytes(s.bytes) }),
    s.sidecarDir ? pathRow('Tool results & subagents', s.sidecarDir) : null,
    ...s.satellites
      .filter((x) => x.kind !== 'sidecar')
      .map((x) => pathRow(x.label, x.path, { note: `${formatBytes(x.bytes)} · ${x.files} file${x.files === 1 ? '' : 's'}` })),
    project ? pathRow('Project data directory', project.dir) : null,
    project ? pathRow('Working directory', project.realPath, { missing: !project.cwdExists }) : null,
  ].filter(Boolean);

  return el('details', { class: 'card', style: { padding: '0' } },
    el('summary', { style: { padding: '12px 16px', cursor: 'pointer', fontWeight: '600', fontSize: '13px' } },
      `Locations on disk (${rows.length})`),
    el('div', { style: { padding: '0 16px 14px' } }, rows)
  );
}

function body(entries, subagents, session) {
  const node = el('div', { class: 'drawer-body' });

  node.append(locations(session));

  if (subagents.length) {
    node.append(el('div', { class: 'card' },
      el('h3', {}, `${subagents.length} subagent transcript${subagents.length === 1 ? '' : 's'}`),
      el('div', { class: 'desc' }, 'Spawned agents stored alongside this session. They are deleted with it.'),
      subagents.map((a) =>
        el('div', { class: 'row-facts', style: { padding: '3px 0' } },
          el('span', { class: 'mono' }, a.agentId.slice(0, 10)),
          a.agentType ? el('span', {}, el('b', {}, 'type'), ' ', a.agentType) : null,
          a.model ? el('span', {}, el('b', {}, 'model'), ' ', shortModel(a.model)) : null,
          a.status ? el('span', {}, el('b', {}, 'status'), ' ', a.status) : null,
          el('span', {}, formatBytes(a.bytes)),
          a.description ? el('span', { class: 'dim' }, a.description.slice(0, 90)) : null
        )
      )
    ));
  }

  if (!entries.length) {
    node.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '◌'), el('h3', {}, 'This transcript has no messages')));
    return node;
  }

  for (const entry of entries) node.append(renderEntry(entry));
  return node;
}

function renderEntry(entry) {
  const label = entry.role === 'tool_result' ? 'result' : entry.role;
  return el('div', { class: `msg role-${entry.role}` },
    el('div', { class: 'msg-gutter' },
      el('div', { class: 'msg-role' }, label),
      entry.ts ? el('div', { class: 'msg-time' }, new Date(entry.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) : null,
      entry.sidechain ? el('div', { class: 'sidechain-tag' }, 'agent') : null
    ),
    el('div', { class: 'msg-body' },
      entry.role === 'assistant' && (entry.model || entry.skill)
        ? el('div', { class: 'row-facts', style: { marginBottom: '5px' } },
            entry.model ? el('span', { class: 'faint' }, shortModel(entry.model)) : null,
            entry.effort ? el('span', { class: 'faint' }, `effort ${entry.effort}`) : null,
            entry.skill ? el('span', { class: 'badge badge-mute' }, entry.skill) : null
          )
        : null,
      entry.blocks.map((b) => renderBlock(b, entry))
    )
  );
}

function renderBlock(b, entry) {
  if (b.type === 'text') {
    return el('div', { class: `bubble${entry.role === 'user' ? ' bubble-user' : ''}` },
      b.text,
      b.truncated ? truncNote(b) : null
    );
  }
  if (b.type === 'thinking') {
    return el('details', { class: 'tool' },
      el('summary', {}, el('span', { class: 'tname' }, 'thinking'), el('span', { class: 'targ' }, `${b.fullLength.toLocaleString()} chars`)),
      el('pre', {}, b.text, b.truncated ? `\n\n… ${(b.fullLength - b.text.length).toLocaleString()} more characters` : '')
    );
  }
  if (b.type === 'image') {
    return el('div', { class: 'bubble dim' }, '[image]');
  }
  if (b.type === 'tool_use') {
    return el('details', { class: 'tool' },
      el('summary', {},
        el('span', { class: 'tname' }, b.name),
        el('span', { class: 'targ' }, b.summary || '')
      ),
      el('pre', {}, b.text, b.truncated ? `\n\n… ${(b.fullLength - b.text.length).toLocaleString()} more characters` : '')
    );
  }
  if (b.type === 'tool_result') {
    const lines = (b.text.match(/\n/g) || []).length + 1;
    const first = b.text.split('\n', 1)[0].slice(0, 140);
    return el('details', { class: `tool${b.isError ? ' err' : ''}` },
      el('summary', {},
        el('span', { class: 'tname' }, b.isError ? `${b.toolName || 'tool'} failed` : `${b.toolName || 'tool'} →`),
        el('span', { class: 'targ' }, b.text.trim() ? `${first}${lines > 1 ? `   (${lines} lines)` : ''}` : '(no output)')
      ),
      el('pre', {}, b.text || '(no output)', b.truncated ? `\n\n… ${(b.fullLength - b.text.length).toLocaleString()} more characters` : '')
    );
  }
  return null;
}

function truncNote(b) {
  return el('div', { class: 'trunc' }, `Truncated — ${(b.fullLength - b.text.length).toLocaleString()} more characters in the file.`);
}
