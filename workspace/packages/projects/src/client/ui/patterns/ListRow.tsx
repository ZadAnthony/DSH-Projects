import type { ComponentProps, ReactNode } from "react";

/** Host list-card structure; its one native button owns keyboard activation. */
export function ListRow({ icon, trailing, children, className, ...props }: ComponentProps<"button"> & {
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return <button {...props} type={props.type ?? "button"}
    className={["projects-ui__list-row", icon === undefined && "projects-ui__list-row--compact", className].filter(Boolean).join(" ")}>
    {icon !== undefined && <span className="projects-ui__list-row-icon" aria-hidden="true">{icon}</span>}
    <span className="projects-ui__list-row-main">{children}</span>
    {trailing !== undefined && <span className="projects-ui__list-row-end">{trailing}</span>}
  </button>;
}
