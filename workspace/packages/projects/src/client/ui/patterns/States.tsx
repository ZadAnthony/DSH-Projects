import { useEffect, useRef, useState, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { Button, IconFolderOpenOutlineRegular, IconInfoOutlineRegular, IconRefreshOutlineRegular, IconWarningOutlineRegular,
  StateDot, Toast } from "../primitives.tsx";

type StateProps = HTMLAttributes<HTMLDivElement> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
};

export function EmptyState({ title, description, icon, actions, children, className, ...props }: StateProps) {
  return <div {...props} className={["projects-ui__empty", className].filter(Boolean).join(" ")}>
    <span className="projects-ui__state-icon" aria-hidden="true">{icon ?? <IconFolderOpenOutlineRegular size={32} />}</span>
    <div className="projects-ui__state-title">{title}</div>
    {description !== undefined && <div className="projects-ui__state-description">{description}</div>}
    {children}
    {actions !== undefined && <div className="projects-ui__state-actions">{actions}</div>}
  </div>;
}

export type ErrorStateProps = Omit<StateProps, "actions"> & { inline?: boolean; retry?: () => void; retryLabel?: string; diagnostic?: { readonly label: string; readonly content: string } };
export function ErrorState({ title, description, icon, children, className, inline, retry, retryLabel, diagnostic, ...props }: ErrorStateProps) {
  useEffect(() => {
    if (diagnostic !== undefined) console.error('[dsh-projects]', diagnostic.label, diagnostic.content);
  }, [diagnostic?.label, diagnostic?.content]);
  return <div role="alert" {...props}
    className={[inline ? "projects-ui__field-error" : "projects-ui__error", className].filter(Boolean).join(" ")}>
    {!inline && <span className="projects-ui__state-icon" aria-hidden="true">{icon ?? <IconWarningOutlineRegular />}</span>}
    <div className="projects-ui__state-title">{title}</div>
    {description !== undefined && <div className="projects-ui__state-description">{description}</div>}
    {children}
    {retry !== undefined && <div className="projects-ui__state-actions">
      <Button variant="outline" size="sm" onClick={retry} icon={<IconRefreshOutlineRegular />}
        aria-label={retryLabel ?? (typeof title === "string" ? title : undefined)}>{retryLabel}</Button>
    </div>}
  </div>;
}

export function LoadingState({ label, rows = 0, className, ...props }: HTMLAttributes<HTMLDivElement> & { label?: string; rows?: number }) {
  const count = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  return <div role="status" aria-busy="true" {...props}
    data-loading-layout={count > 0 ? "list" : "inline"}
    className={["projects-ui__loading", count > 0 ? "projects-ui__loading-list" : "projects-ui__loading-inline", className].filter(Boolean).join(" ")}>
    {count > 0 ? <>
      {label !== undefined && <span className="projects-ui__loading-label"><StateDot state="ongoing" />{label}</span>}
      {Array.from({ length: count }, (_, index) => <div key={index} className="projects-ui__skeleton-row" aria-hidden="true">
        <span className="projects-ui__skeleton" /><span className="projects-ui__skeleton projects-ui__skeleton-short" />
      </div>)}
    </> : <><StateDot state="ongoing" />{label !== undefined && <span>{label}</span>}</>}
  </div>;
}

export type FeedbackProps = Omit<ComponentProps<typeof Toast>, "tone"> & { tone?: "success" | "error" | "warning" | "info" };
/** Operation results use the host's actual Toast; durable unknown/conflict UI stays with its caller. */
export function Feedback(props: FeedbackProps) {
  // A changed result starts a new host lifetime. Repeating an identical operation
  // still uses the caller's sequence/key, as it does for the native Toast.
  return <FeedbackLifetime key={JSON.stringify([props.text, props.tone])} {...props} />;
}

function FeedbackLifetime({ tone, icon, onDone, ...props }: FeedbackProps) {
  const [visible, setVisible] = useState(true);
  const completed = useRef(false);
  if (!visible) return null;
  return <Toast {...props} tone={tone === "success" ? "success" : undefined}
    icon={icon ?? (tone === "success" ? undefined : tone === "info" ? <IconInfoOutlineRegular /> : <IconWarningOutlineRegular />)}
    onDone={() => {
      if (completed.current) return;
      completed.current = true;
      setVisible(false);
      onDone();
    }} />;
}
