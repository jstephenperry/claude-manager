// Turns a raw .jsonl transcript into a list of renderable entries.
//
// The renderer never sees the raw records: text blocks are capped, tool inputs
// are summarised down to the one or two fields worth showing in a list, and
// bookkeeping records (queue-operation, ai-title, last-prompt) are dropped.
// Without that a 6 MB transcript would ship 6 MB over IPC and lock up the UI.

import { readJsonl } from './util.js';

const MAX_BLOCK_CHARS = 20000;

function clip(text, limit = MAX_BLOCK_CHARS) {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2) ?? '';
  if (s.length <= limit) return { text: s, truncated: false, fullLength: s.length };
  return { text: s.slice(0, limit), truncated: true, fullLength: s.length };
}

/** The one-line summary shown on a collapsed tool call. */
function summariseToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k];
    return '';
  };
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return pick('command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Grep':
      return `${pick('pattern')}${input.path ? '  in ' + input.path : ''}`;
    case 'Glob':
      return pick('pattern');
    case 'Agent':
      return pick('description', 'prompt');
    case 'Skill':
      return pick('skill');
    case 'WebFetch':
    case 'WebSearch':
      return pick('url', 'query');
    default: {
      const first = pick('description', 'prompt', 'query', 'path', 'file_path', 'command');
      return first || Object.keys(input).slice(0, 3).join(', ');
    }
  }
}

function toolResultText(block, record) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  const r = record?.toolUseResult;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      return [r.stdout, r.stderr && '[stderr]\n' + r.stderr].filter(Boolean).join('\n');
    }
    if (typeof r.content === 'string') return r.content;
    return JSON.stringify(r, null, 2);
  }
  return '';
}

/**
 * Read a transcript into UI entries.
 *
 * @param file absolute path to the .jsonl
 * @param opts.includeThinking include thinking blocks (default true)
 */
export async function readTranscript(file, opts = {}) {
  const includeThinking = opts.includeThinking !== false;
  const entries = [];
  const toolNamesById = new Map();
  let index = 0;

  await readJsonl(file, (o) => {
    const base = {
      i: index,
      uuid: o.uuid || null,
      ts: o.timestamp || null,
      sidechain: Boolean(o.isSidechain),
      agentId: o.agentId || null,
    };

    if (o.type === 'user') {
      const content = o.message?.content;
      const blocks = [];

      if (typeof content === 'string') {
        blocks.push({ type: 'text', ...clip(content) });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') {
            blocks.push({ type: 'text', ...clip(b.text) });
          } else if (b.type === 'tool_result') {
            blocks.push({
              type: 'tool_result',
              toolUseId: b.tool_use_id,
              toolName: toolNamesById.get(b.tool_use_id) || '',
              isError: Boolean(b.is_error),
              ...clip(toolResultText(b, o)),
            });
          } else if (b.type === 'image') {
            blocks.push({ type: 'image' });
          }
        }
      }
      if (!blocks.length) return;

      // A turn that is only tool results is the tool's output, not the user
      // speaking -- label it so the UI does not draw it as a user message.
      const onlyResults = blocks.every((b) => b.type === 'tool_result');
      entries.push({ ...base, role: onlyResults ? 'tool_result' : 'user', blocks, meta: o.isMeta ? true : undefined });
      index += 1;
      return;
    }

    if (o.type === 'assistant') {
      const m = o.message;
      const content = Array.isArray(m?.content) ? m.content : [];
      const blocks = [];
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim()) {
          blocks.push({ type: 'text', ...clip(b.text) });
        } else if (b.type === 'thinking') {
          // Claude Code writes the block's signature but not its text, so in
          // practice `thinking` is an empty string and there is nothing to
          // render. The branch stays for transcripts that do carry the text.
          if (includeThinking && b.thinking?.trim()) blocks.push({ type: 'thinking', ...clip(b.thinking) });
        } else if (b.type === 'tool_use') {
          toolNamesById.set(b.id, b.name);
          blocks.push({
            type: 'tool_use',
            id: b.id,
            name: b.name,
            summary: clip(summariseToolInput(b.name, b.input), 400).text,
            ...clip(b.input),
          });
        }
      }
      if (!blocks.length) return;
      entries.push({
        ...base,
        role: 'assistant',
        model: m?.model || '',
        effort: o.effort || '',
        skill: o.attributionSkill || '',
        usage: m?.usage
          ? {
              input: m.usage.input_tokens || 0,
              output: m.usage.output_tokens || 0,
              cacheRead: m.usage.cache_read_input_tokens || 0,
              cacheCreate: m.usage.cache_creation_input_tokens || 0,
            }
          : null,
        blocks,
      });
      index += 1;
      return;
    }

    // `attachment` records are harness bookkeeping (deferred-tool deltas,
    // context notices). A long session carries hundreds of them and none say
    // anything a reader wants, so they are dropped rather than rendered.
  });

  return entries;
}

/** List the subagent transcripts stored alongside a session. */
export async function readSubagentMeta(metaPath) {
  const { readJsonSafe } = await import('./util.js');
  return readJsonSafe(metaPath, null);
}
