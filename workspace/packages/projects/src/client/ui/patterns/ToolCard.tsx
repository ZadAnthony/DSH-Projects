import { Children, useState, type HTMLAttributes, type ReactNode } from "react";
import { DisclosureRow, IconCodeOutlineRegular } from "../primitives.tsx";

export type ToolCardProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  readonly title: string;
  readonly icon?: ReactNode;
  readonly status?: ReactNode;
  readonly running?: boolean;
  /** Durable exceptions and known partial effects stay visible when collapsed. */
  readonly persistent?: ReactNode;
  readonly actions?: ReactNode;
  readonly defaultOpen?: boolean;
};

/** Presentation only: the caller owns result semantics, raw content and actions. */
export function ToolCard({ title, icon, status, running, persistent, actions, children,
  defaultOpen = false, className, ...props }: ToolCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = Children.toArray(children).length > 0;
  return <div {...props} className={["projects-ui__tool-card", className].filter(Boolean).join(" ")}>
    <DisclosureRow title={title} icon={icon ?? <IconCodeOutlineRegular />} open={expandable && open}
      expandable={expandable} expandOnRowClick keepContentWhenOpen running={running}
      onToggle={() => setOpen(value => !value)} className="projects-ui__tool-card-disclosure"
      rowClassName="projects-ui__tool-card-header" titleClassName="projects-ui__tool-card-title"
      contentClassName="projects-ui__tool-card-heading" contentLayoutClassName="projects-ui__tool-card-heading-layout"
      leadingClassName="projects-ui__tool-card-leading" chevronClassName="projects-ui__tool-card-chevron"
      collapsedContent={status === undefined ? undefined : <span className="projects-ui__tool-card-status">{status}</span>}>
      <div className="projects-ui__tool-card-body">{children}</div>
    </DisclosureRow>
    {persistent !== undefined && <div className="projects-ui__tool-card-persistent">{persistent}</div>}
    {actions !== undefined && <div className="projects-ui__tool-card-actions">{actions}</div>}
  </div>;
}
