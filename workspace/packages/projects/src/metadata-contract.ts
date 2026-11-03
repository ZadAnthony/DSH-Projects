/** Pure transaction scope type; shared contracts never import filesystem implementations. */
export interface RootWriteScope {
  readonly root: string
  readonly anchorPath: string
  assertCurrent(): Promise<void>
}
