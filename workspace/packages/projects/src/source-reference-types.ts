/** Stable browser-safe native record references shared by chat, memory and communication. */
export type LegacyNativeProjectSource =
  | { readonly kind: 'message'; readonly hostSessionId: string; readonly messageId: string }
  | { readonly kind: 'tool'; readonly hostSessionId: string; readonly toolCallId: string }

export interface NativeBodySelection {
  readonly stream: 'visible-blocks' | 'tool-value' | 'model-result'
  readonly codec: 'canonical-json/v1'
  readonly digest: string
  readonly range?: { readonly unit: 'unicode-code-points'; readonly start: number; readonly end: number }
}

/** Event coordinates refer to the canonical logical format, never a physical predecessor's seq. */
export interface NativeEventSource {
  readonly kind: 'native-event'
  readonly version: 1
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly sessionCreatedAt: number
  readonly eventSpace: { readonly kind: 'canonical'; readonly formatVersion: number }
  readonly eventSeq: number
  readonly eventType: string
  readonly eventDigest: string
  readonly messageId?: string
  readonly toolCallId?: string
  readonly body?: NativeBodySelection
}

/** Old message/tool locators remain read-only compatibility inputs. New reads mint native-event. */
export type NativeProjectSource = LegacyNativeProjectSource | NativeEventSource
