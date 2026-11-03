import { Button, IconCloseOutlineRegular, IconDatabaseOutlineRegular } from "./ui/index.ts";
import { createContext, useContext, useState, type ReactNode } from "react";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { ProjectMemoryNotice } from "../memory-notices.ts";
import type { ProjectDetail } from "../public-types.ts";

export interface ProjectMemoryNoticeInjected {
  readonly hooks: {
    readonly projectMemoryNotice: HostObservable<ProjectMemoryNotice | undefined>;
    readonly projectDetail: HostObservable<ProjectDetail | undefined>;
  };
}

export type ProjectMemoryNoticeProps = PropsRuntime<"conversation.input.dock"> &
  PropsLocale<"projects"> & InjectFace<ProjectMemoryNoticeInjected>;

/** The active Project UI owns guarded navigation to its existing memory editor. */
export const MemoryNoticeNavigationContext = createContext<((notice: ProjectMemoryNotice) => void) | undefined>(undefined);

/** An ambient success strip in the current Project's work-session composers. */
export function MemoryNotice({
  sessionId,
  useProjectMemoryNotice,
  useProjectDetail,
  t,
}: ProjectMemoryNoticeProps): ReactNode {
  const openDetails = useContext(MemoryNoticeNavigationContext);
  const [dismissedNotice, setDismissedNotice] = useState<ProjectMemoryNotice>();
  const notice = useProjectMemoryNotice((value) => value);
  const belongsToCurrentProject = useProjectDetail((detail) =>
    detail?.project.id === notice?.projectId &&
    detail?.sessions.some((session) =>
      (session.role === "main" || session.role === "execution") &&
      session.hostSessionId === sessionId,
    ) === true,
  );
  if (notice === undefined || !belongsToCurrentProject) return null;
  if (notice === dismissedNotice) return null;
  return (
    <div className="dsh-projects__memory-notice dsp-memory-notice projects-ui__memory-notice" role="status" aria-live="polite">
      <IconDatabaseOutlineRegular /><span>{t(notice.kind === "added" ? "project.memory.added" : "project.memory.updated")}</span>
      {openDetails !== undefined && <Button variant="ghost" size="sm" type="button" onClick={() => openDetails(notice)}>{t("p3.cards.memory.details")}</Button>}
      <Button variant="ghost" size="sm" type="button" icon={<IconCloseOutlineRegular />} aria-label={t("p3.cards.notice.dismiss")} onClick={() => setDismissedNotice(notice)} />
    </div>
  );
}
