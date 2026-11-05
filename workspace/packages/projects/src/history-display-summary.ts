/** Presentation only: exact history text, matches and source ranges retain their original authority. */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { codePointLength, sliceCodePoints } from './canonical-chunks.ts';
import { isReplySessionLinkDestination } from './reply-session-links.ts';
import { PROJECT_HISTORY_SESSION_LINK_COPY, type ProjectHistoryDisplaySummary } from './project-history-types.ts';

const sessionLinkWidth = Math.max(...PROJECT_HISTORY_SESSION_LINK_COPY.map(codePointLength));

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string | null;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
}

function labelText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  return node.children?.map(labelText).join('') ?? '';
}

/** Map a folded label match back to its UTF-16 offset, including lowercase expansion. */
function labelMatchOffset(label: string, keyword: string | undefined): number {
  if (keyword === undefined) return 0;
  const match = label.toLowerCase().indexOf(keyword.toLowerCase());
  if (match < 0) return 0;
  let folded = 0, original = 0;
  for (const point of label) {
    if (folded >= match) break;
    folded += point.toLowerCase().length; original += point.length;
  }
  return original;
}

/**
 * Parse the complete source before clipping: a source excerpt may start inside a
 * destination or cut through an escaped label. Only reserved-host session links
 * are projected. Code, ordinary text and external links keep their source.
 * No identities are inferred from labels, and this string is never navigable.
 */
export function historyDisplaySummary(text: string, matchStart: number, maximum: number, keyword?: string, sourcePartial = false): ProjectHistoryDisplaySummary | undefined {
  if (!text.includes('[') && !text.includes('https://')) return;
  const { replacements, unrepresentablePartial } = historyMarkdownProjection(text, sourcePartial);
  if (unrepresentablePartial) return [{ kind: 'partial-preview' }];
  if (replacements.length === 0) return;
  const sourceAnchor = sliceCodePoints(text, 0, matchStart).length;
  let anchor = sourceAnchor, consumed = 0, delta = 0;
  const chunks: (string | { readonly kind: 'session-link' })[] = [];
  for (const link of replacements) {
    const length = link.label?.length ?? sessionLinkWidth;
    chunks.push(text.slice(consumed, link.start), link.label ?? { kind: 'session-link' });
    if (sourceAnchor >= link.end) anchor += length - (link.end - link.start);
    else if (sourceAnchor >= link.start) anchor = link.start + delta + (link.label === undefined ? 0 : labelMatchOffset(link.label, keyword));
    delta += length - (link.end - link.start);
    consumed = link.end;
  }
  chunks.push(text.slice(consumed));
  // Budget the widest shipped translation before choosing the context window.
  // The private padding is only arithmetic; literal user U+FFFC stays plain text.
  const projected = chunks.map(part => typeof part === 'string' ? part : '\ufffc'.repeat(sessionLinkWidth)).join('');
  if (projected.trim() === '') return [{ kind: 'session-link' }];
  const start = Math.max(0, codePointLength(projected.slice(0, anchor)) - 64);
  const parts: (string | { readonly kind: 'session-link' })[] = [];
  let position = 0;
  for (const chunk of chunks) {
    const length = typeof chunk === 'string' ? codePointLength(chunk) : sessionLinkWidth;
    const from = Math.max(0, start - position), to = Math.min(length, start + maximum - position);
    if (to > from && (typeof chunk === 'string' || from === 0 && to === length)) parts.push(typeof chunk === 'string' ? sliceCodePoints(chunk, from, to) : chunk);
    position += length;
    if (position >= start + maximum) break;
  }
  return parts;
}

interface MarkdownReplacement { readonly start: number; readonly end: number; readonly label: string | undefined; readonly incomplete: boolean }

/** One grammar and source-offset traversal owns both summary and full-record presentation. */
function historyMarkdownProjection(text: string, sourcePartial: boolean) {
  const root = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, string>();
  function collectDefinitions(node: MarkdownNode): void {
    if (node.type === 'definition' && node.identifier !== undefined && node.url !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collectDefinitions(child);
  }
  collectDefinitions(root);
  const replacements: MarkdownReplacement[] = [], images: { start: number; end: number; alt: string }[] = [];
  let unrepresentablePartial = false;
  let textOnly = false;
  function visit(node: MarkdownNode, previous?: MarkdownNode): void {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    const destination = node.type === 'linkReference' && node.identifier !== undefined ? definitions.get(node.identifier) : node.url;
    if ((node.type === 'link' || node.type === 'linkReference' || node.type === 'definition')
      && destination !== undefined && isReplySessionLinkDestination(destination) && start !== undefined && end !== undefined) {
      const label = labelText(node);
      // GFM can recognize the URI inside an unfinished outer Markdown link.
      // Its preceding raw text still owns the dangling label syntax. A saved
      // partial source cannot supply the missing structure: show an honest
      // localized fragment notice rather than reconstructing it or its IDs.
      let incomplete = false;
      if (sourcePartial && node.type === 'link' && label === destination && text[start] !== '[' && text[start] !== '<'
        && previous?.type === 'text' && previous.position?.start.offset !== undefined && previous.position.end.offset !== undefined) {
        const before = text.slice(previous.position.start.offset, previous.position.end.offset).trimEnd();
        incomplete = before.endsWith('](') || before.endsWith('<');
        unrepresentablePartial ||= incomplete;
      }
      replacements.push({ start, end, label: node.type === 'definition' ? '' : label === destination || label === '' ? undefined : label, incomplete });
      return;
    }
    if ((node.type === 'image' || node.type === 'imageReference') && start !== undefined && end !== undefined) images.push({ start, end, alt: node.alt ?? '' });
    // Native Markdown automatically links an inline-code token that is itself a
    // whole HTTP URL. Its public API cannot disable that anchor without changing
    // the code text, so this uncommon record retains the existing safe text view.
    if (node.type === 'inlineCode' && node.value !== undefined && node.value.trim() === node.value && isReplySessionLinkDestination(node.value)) textOnly = true;
    for (const [index, child] of (node.children ?? []).entries()) visit(child, node.children?.[index - 1]);
  }
  visit(root);
  return { replacements, images, unrepresentablePartial, textOnly };
}

function escapedMarkdownText(text: string): string { return text.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu, '\\$&'); }

/** Full source presentation only: no clipping, source rewrite, invented label or navigation authority. */
export function historyRecordReadingProjection(text: string, copy: { readonly sessionLink: string; readonly incompleteReference: string; readonly image: string }, sourcePartial = false): { readonly text: string; readonly textOnly: boolean } {
  const parsed = historyMarkdownProjection(text, sourcePartial);
  const replacements = [
    ...parsed.replacements.map(link => ({ start: link.start, end: link.end, text: escapedMarkdownText(link.incomplete ? copy.incompleteReference : link.label ?? copy.sessionLink) })),
    ...parsed.images.map(image => ({ start: image.start, end: image.end, text: escapedMarkdownText(image.alt || copy.image) })),
  ].sort((left, right) => left.start - right.start);
  let result = '', consumed = 0;
  for (const replacement of replacements) { result += text.slice(consumed, replacement.start) + replacement.text; consumed = replacement.end; }
  return { text: result + text.slice(consumed), textOnly: parsed.textOnly };
}
