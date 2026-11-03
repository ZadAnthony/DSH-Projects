import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { IconAction, IconEllipsisOutlineRegular, Menu, type MenuEntry } from "../primitives.tsx";

export interface ActionMenuProps {
  label: string;
  items: readonly MenuEntry[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  className?: string;
}

/** Return focus to a persistent trigger before any action can open a Modal. */
export function ActionMenu({ label, items, onSelect, disabled, className }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <Menu open={open && !disabled} portal autoFocus align="end" items={items}
    className={className} onClose={() => { setOpen(false); }}
    onSelect={id => {
      if (trigger.current?.matches(":disabled") === true) return;
      trigger.current?.focus();
      flushSync(() => { setOpen(false); });
      onSelect(id);
    }}
    anchor={<IconAction ref={trigger} className="projects-ui__action-menu-trigger" disabled={disabled}
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open && !disabled}
      icon={<IconEllipsisOutlineRegular />} onClick={() => { setOpen(current => !current); }} />} />;
}
