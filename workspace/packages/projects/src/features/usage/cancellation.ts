/** Cancel one consumer without rejecting or interrupting a shared producer. */
export function waitForUsageConsumer<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) {
    // The producer may have started before admission synchronously cancelled.
    void operation.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
