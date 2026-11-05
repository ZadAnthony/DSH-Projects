/** Versioned, explicit reply references. Identity and navigation stay with the Project owner. */
export type ReplySessionLinkTarget = { readonly projectId: string; readonly sessionId: string }

export const REPLY_SESSION_LINK_ORIGIN = 'https://dsh-projects.invalid'
const HOSTNAME = 'dsh-projects.invalid'

/** IDs remain ordinary single record segments; membership is checked only by navigation. */
function validId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && value !== '.' && value !== '..' && !/[\/\\\u0000-\u001f\u007f]/u.test(value)
}

export function makeReplySessionLink(projectId: string, sessionId: string): string {
  if (!validId(projectId) || !validId(sessionId)) throw new Error('Reply session references require valid Project record IDs')
  return `${REPLY_SESSION_LINK_ORIGIN}/session/v1/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`
}

/** Only the exact canonical wire form is accepted, including its percent-encoding. */
export function parseReplySessionLink(href: string): ReplySessionLinkTarget | undefined {
  if (typeof href !== 'string') return
  try {
    const url = new URL(href)
    if (url.origin !== REPLY_SESSION_LINK_ORIGIN || url.username !== '' || url.password !== ''
      || url.port !== '' || url.search !== '' || url.hash !== '') return
    const match = /^\/session\/v1\/([^/]+)\/([^/]+)$/u.exec(url.pathname)
    if (match === null) return
    const projectId = decodeURIComponent(match[1]!), sessionId = decodeURIComponent(match[2]!)
    if (!validId(projectId) || !validId(sessionId) || makeReplySessionLink(projectId, sessionId) !== href) return
    return { projectId, sessionId }
  } catch { return }
}

/** Own the entire reserved host, even when its path, credentials or port are invalid. */
export function isReplySessionLinkDestination(href: string): boolean {
  if (typeof href !== 'string') return false
  try { return new URL(href).hostname.toLowerCase().replace(/\.$/u, '') === HOSTNAME }
  catch {
    // URL rejects malformed ports before exposing hostname. Those references must
    // still be consumed internally rather than falling through to a browser.
    const authority = /^(?:[a-z][a-z\d+.-]*:)?\/\/([^/?#]*)/iu.exec(href.trim())?.[1]
    const host = authority?.slice(authority.lastIndexOf('@') + 1).split(':')[0]
    try { return host !== undefined && decodeURIComponent(host).toLowerCase().replace(/\.$/u, '') === HOSTNAME }
    catch { return false }
  }
}

/** Escape label syntax without changing the stored identity or interpreting title text. */
export function makeReplySessionMention(projectId: string, sessionId: string, title: string): string {
  const label = title.replace(/\r\n?|\n/gu, ' ').replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu, '\\$&')
  const destination = makeReplySessionLink(projectId, sessionId).replace(/[()]/gu, '\\$&')
  return `[${label}](${destination})`
}
