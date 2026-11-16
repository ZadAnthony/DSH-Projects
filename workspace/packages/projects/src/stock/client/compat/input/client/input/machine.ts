/**
 * SubmitMachine: the pure per-session submit-plane state machine.
 * Events in, effects out; zero React / DOM / cordis. Package-private; the
 * SessionInput shell owns editor state and executes the returned effects.
 *
 * Commands and messages keep one frozen in-flight slot until their result is known.
 */
import type { InputSubmitMode, MessageSubmission } from '../contract/composer-submission.ts'
import type { CommandClaim, InputEffect, InputEvent, InputState, SubmitAttempt } from '../contract/input.ts'

/** Exhaustiveness backstop for the closed InputEvent union. */
function unreachable(value: never): never {
  throw new Error(`unreachable input event: ${JSON.stringify(value)}`)
}

/** Strip a claimed command token from its submit-time draft. */
function argsAfter(draft: string, token: string): string {
  const s = draft.trimStart()
  if (s.startsWith(token)) return s.slice(token.length)
  const base = token.trimEnd()
  if (s.startsWith(base)) {
    const rest = s.slice(base.length)
    return /^\s/.test(rest) ? rest.slice(1) : rest
  }
  return ''
}

/** A claimed name may stand alone; arguments require the token's separator. */
function retainsClaim(draft: string, token: string): boolean {
  return draft.startsWith(token) || draft === token.trimEnd()
}

/** The submit-plane slice of the published InputState. */
export interface SubmitSnapshot {
  readonly phase: InputState['phase']
  readonly claim?: InputState['claim']
}

/** Pure phase, claim, and attempt owner for one Session input. */
export class SubmitMachine {
  private phase: InputState['phase'] = 'plain'
  private claim: CommandClaim | undefined
  private seq = 0
  private inflight: {
    readonly attempt: SubmitAttempt
    readonly controller: AbortController
  } | undefined

  /** Read-only snapshot of the submit-plane state. */
  get state(): SubmitSnapshot {
    const c = this.claim
    return {
      phase: this.phase,
      ...(c
        ? {
          claim: {
            name: c.name,
            token: c.token,
            ...(c.hint !== undefined ? { hint: c.hint } : {}),
            ...(c.attachments === true ? { attachments: true } : {}),
          },
        }
        : {}),
    }
  }

  /**
   * Feed one event through the machine.
   * @param ev - submit-plane event.
   * @returns effects for the SessionInput shell, in execution order.
   */
  dispatch(ev: InputEvent): readonly InputEffect[] {
    switch (ev.type) {
      case 'draft-changed': return this.onDraftChanged(ev.draft)
      case 'claim': return this.onClaim(ev.claim)
      case 'enter': return this.onEnter(ev.mode, ev.draft, ev.submission, ev.hasAttachments)
      case 'adjudicated': return this.onAdjudicated(ev.attempt, ev.outcome)
      case 'adjudication-failed': return this.onAdjudicationFailed(ev.attempt, ev.message)
      case 'submit-settled': return this.onSubmitSettled(ev)
      case 'sink-settled': return this.onSinkSettled(ev)
      case 'release': return this.onRelease()
      default: return unreachable(ev)
    }
  }

  /** The complete command name retains its claim with or without the argument separator. */
  private onDraftChanged(draft: string): readonly InputEffect[] {
    if (this.phase === 'claimed' && this.claim !== undefined && !retainsClaim(draft, this.claim.token)) {
      this.phase = 'plain'
      this.claim = undefined
    }
    return []
  }

  /** The editor applied a claim-token replacement; busy phases refuse another claim. */
  private onClaim(claim: CommandClaim): readonly InputEffect[] {
    if (this.phase !== 'plain' && this.phase !== 'claimed') return []
    this.claim = claim
    this.phase = 'claimed'
    return []
  }

  /** Mint an attempt and controller without assigning its lifecycle owner. */
  private mintAttempt(mode: InputSubmitMode, draft: string, submission?: MessageSubmission): {
    readonly attempt: SubmitAttempt
    readonly controller: AbortController
  } {
    const controller = new AbortController()
    this.seq += 1
    return {
      attempt: { seq: this.seq, signal: controller.signal, draftSnapshot: draft, mode, ...submission === undefined ? {} : { submission } },
      controller,
    }
  }

  /** Mint the frozen command/adjudication attempt. */
  private beginAttempt(mode: InputSubmitMode, draft: string, submission?: MessageSubmission): SubmitAttempt {
    const flight = this.mintAttempt(mode, draft, submission)
    this.inflight = flight
    return flight.attempt
  }

  /** 普通消息保留草稿，直到Host确认接收。 */
  private beginSending(mode: InputSubmitMode, draft: string, submission?: MessageSubmission): SubmitAttempt {
    const attempt = this.beginAttempt(mode, draft, submission)
    this.claim = undefined
    this.phase = 'sending'
    return attempt
  }

  private sendingEffects(attempt: SubmitAttempt): readonly InputEffect[] {
    return [{ type: 'default-sink', attempt, draft: attempt.draftSnapshot, mode: attempt.mode }]
  }

  private onEnter(mode: InputSubmitMode, draft: string, submission?: MessageSubmission, hasAttachments = false): readonly InputEffect[] {
    if (this.phase === 'adjudicating' || this.phase === 'submitting' || this.phase === 'sending') return []
    if (this.phase === 'claimed' && this.claim !== undefined) {
      const attempt = this.beginAttempt(mode, draft, submission)
      this.phase = 'submitting'
      return [{ type: 'begin-submit', attempt, claim: this.claim, args: argsAfter(draft, this.claim.token) }]
    }
    const trimmed = draft.trim()
    if (trimmed === '' && !hasAttachments) return []
    if (trimmed.startsWith('/')) {
      const attempt = this.beginAttempt(mode, draft, submission)
      this.phase = 'adjudicating'
      return [{ type: 'adjudicate', attempt, draft }]
    }
    return this.sendingEffects(this.beginSending(mode, draft, submission))
  }

  private onAdjudicated(
    attempt: SubmitAttempt,
    outcome: Extract<InputEvent, { type: 'adjudicated' }>['outcome'],
  ): readonly InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'adjudicating' || flight === undefined || flight.attempt.seq !== attempt.seq) return []
    if (outcome !== undefined && outcome !== 'handled' && 'claim' in outcome) {
      this.claim = outcome.claim
      this.phase = 'submitting'
      return [{
        type: 'begin-submit',
        attempt,
        claim: outcome.claim,
        args: argsAfter(attempt.draftSnapshot, outcome.claim.token),
      }]
    }
    if (outcome !== undefined) { this.inflight = undefined; this.phase = 'plain'; return [] }
    this.phase = 'sending'
    return this.sendingEffects(attempt)
  }

  private onAdjudicationFailed(attempt: SubmitAttempt, message: string): readonly InputEffect[] {
    if (this.phase !== 'adjudicating' || this.inflight?.attempt.seq !== attempt.seq) return []
    this.inflight = undefined
    this.phase = 'plain'
    return [{ type: 'notice', level: 'error', text: message }]
  }

  /** Claimed command settlement retains the frozen transaction semantics. */
  private onSubmitSettled(ev: Extract<InputEvent, { type: 'submit-settled' }>): readonly InputEffect[] {
    const flight = this.inflight
    if (this.phase !== 'submitting' || flight === undefined || flight.attempt.seq !== ev.attempt.seq) return []
    this.inflight = undefined
    if (ev.ok) {
      this.phase = 'plain'
      this.claim = undefined
      const effects: InputEffect[] = [{ type: 'commit-draft', retainSuffixOf: flight.attempt.draftSnapshot }]
      if (ev.outcome?.text !== undefined) {
        effects.push({ type: 'notice', level: ev.outcome.kind === 'error' ? 'error' : 'info', text: ev.outcome.text })
      }
      return effects
    }
    const text = ev.message ?? ev.outcome?.text
    if (ev.draft === flight.attempt.draftSnapshot
      && this.claim !== undefined && retainsClaim(ev.draft, this.claim.token)) {
      this.phase = 'claimed'
      return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
    }
    this.phase = 'plain'
    this.claim = undefined
    return text === undefined ? [] : [{ type: 'notice', level: 'error', text }]
  }

  /** 只有当前发送的接收结果可以清理其草稿；拒绝保留原稿。 */
  private onSinkSettled(ev: Extract<InputEvent, { type: 'sink-settled' }>): readonly InputEffect[] {
    if (this.phase !== 'sending' || this.inflight?.attempt !== ev.attempt) return []
    this.inflight = undefined
    this.phase = 'plain'
    const effects: InputEffect[] = ev.ok ? [{ type: 'commit-draft', retainSuffixOf: ev.attempt.draftSnapshot }] : []
    const text = ev.message ?? ev.outcome?.text
    if (text !== undefined) effects.push({ type: 'notice', level: ev.ok ? 'info' : 'error', text })
    return effects
  }

  private onRelease(): readonly InputEffect[] {
    if (this.inflight !== undefined) {
      this.inflight.controller.abort()
      this.inflight = undefined
    }
    this.phase = 'plain'
    this.claim = undefined
    return []
  }
}
