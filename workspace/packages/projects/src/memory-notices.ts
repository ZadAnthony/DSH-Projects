/** Browser-safe, future-only notification of a fully settled Memory change. */
export interface ProjectMemoryNotice {
  readonly projectId: string;
  readonly kind: "added" | "updated";
  readonly memoryIds: readonly string[];
}
