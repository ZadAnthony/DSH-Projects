/** Current deletion boundary contracts, shared by the runtime and its private control owner. */
export interface ProjectsDeletionV1Scope {
  readonly dataRoot: string
  assertCurrent(): void
}
export interface ProjectTargetDeletionCut { readonly drained: Promise<void>; commit(): void; release(): void }
