import {
  forwardRef, useCallback, useId, useLayoutEffect, useRef, useState,
  type ComponentProps, type MutableRefObject, type Ref, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { flushSync } from "react-dom";
import {
  Button, IconChevronDownOutlineRegular, Menu, Tooltip as HostTooltip,
  type MenuEntry,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { projectDocumentCopy } from "./copy.ts";

/** Keep host controls, public types, icons, native events and refs unchanged. */
export * from "@deepseek-ai/dsh-client-ui-primitives";

export type IconActionProps = Omit<ComponentProps<typeof Button>, "ref" | "variant" | "size"> & {
  readonly tone?: "secondary" | "primary";
};

/** Host compact ghost Button, composed for the native 28px icon-action role. */
export const IconAction = forwardRef<HTMLButtonElement, IconActionProps>(function IconAction(
  { className, tone = "secondary", ...props }, ref,
) {
  return <Button {...props} ref={ref} variant="ghost" size="sm"
    className={["projects-ui__icon-action", tone === "primary" && "projects-ui__icon-action--primary", className].filter(Boolean).join(" ")} />;
});

/** Floating help must escape the project's scrolling/stacking containers. */
export function Tooltip(props: ComponentProps<typeof HostTooltip>) {
  return <HostTooltip {...props} portal />;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea {...props} ref={ref} className={["projects-ui__textarea", className].filter(Boolean).join(" ")} />;
  },
);
export const TextArea = Textarea;

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "defaultValue" | "multiple" | "onChange"> & (
  | { multiple?: false; value: string; onValueChange: (value: string) => void }
  | { multiple: true; value: readonly string[]; onValueChange: (values: readonly string[]) => void }
);

type Option = { id: string; value: string; label: string; disabled: boolean };
function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref != null) (ref as MutableRefObject<T | null>).current = value;
}

/**
 * Host Button/Menu presentation, with an actual native select as the sole form
 * field. Original option children remain intact, including optgroups and disabled
 * options. The field stays in constraint validation; only its focus is proxied.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, forwardedRef) {
  const { className, children, value, onValueChange, multiple, disabled, onFocus, onInvalid, ...nativeProps } = props;
  const native = useRef<HTMLSelectElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const selectionId = useId();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly Option[]>([]);
  const [items, setItems] = useState<readonly MenuEntry[]>([]);
  const attachNative = useCallback((element: HTMLSelectElement | null) => {
    native.current = element;
    setRef(forwardedRef, element);
  }, [forwardedRef]);

  useLayoutEffect(() => {
    if (native.current === null) return;
    const next: Option[] = [];
    const entries: MenuEntry[] = [];
    let previousGroup: HTMLOptGroupElement | null = null;
    for (const [index, option] of Array.from(native.current.options).entries()) {
      const parent = option.parentElement;
      const group = parent?.tagName === "OPTGROUP" ? parent as HTMLOptGroupElement : null;
      if (group !== null && group !== previousGroup) {
        entries.push({ type: "label", id: `group:${index}`, text: group.label });
      }
      previousGroup = group;
      const entry = { id: `option:${index}`, value: option.value, label: option.label,
        disabled: option.disabled || group?.disabled === true || Boolean(option.hidden) || Boolean(group?.hidden) };
      next.push(entry);
      // Hidden options retain native form semantics without becoming menu actions.
      if (!option.hidden && !group?.hidden) entries.push(entry);
    }
    setOptions(next);
    setItems(entries);
  }, [children]);

  useLayoutEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const selectedValues = multiple ? value as readonly string[] : [value as string];
  const selected = options.filter(option => selectedValues.includes(option.value));
  const label = selected.map(option => option.label).join(", ");
  const copy = projectDocumentCopy(native.current?.ownerDocument ?? (typeof document === "undefined" ? undefined : document));
  const selectionSummary = copy("ui.select.current", { values: label || copy("ui.select.empty") });
  const describedBy = [props["aria-describedby"], selectionId].filter(Boolean).join(" ");
  // Host rows stay actions: expose the current choice and next action without
  // changing roles that the host's keyboard traversal owns.
  const accessibleItems: readonly MenuEntry[] = items.map(entry => {
    if ("type" in entry) return entry;
    const isSelected = selected.some(option => option.id === entry.id);
    const hint = entry.disabled
      ? copy(isSelected ? "ui.select.selectedUnavailable" : "ui.select.unavailable")
      : copy(multiple ? (isSelected ? "ui.select.remove" : "ui.select.add") : (isSelected ? "ui.select.currentChoice" : "ui.select.select"));
    return { ...entry, label: <><span className="projects-ui__select-option-label">{entry.label}</span>{" "}<span className="projects-ui__visually-hidden">{hint}</span></> };
  });
  const isDisabled = () => native.current?.matches(":disabled") === true;
  const close = () => { setOpen(false); };
  const select = (id: string) => {
    const option = options.find(entry => entry.id === id);
    if (option === undefined || option.disabled || isDisabled()) return;
    if (props.multiple) {
      const values = props.value.includes(option.value)
        ? props.value.filter(entry => entry !== option.value) : [...props.value, option.value];
      // Native select values are exposed in document order, including FormData.
      const ordered = options.filter(entry => values.includes(entry.value)).map(entry => entry.value);
      props.onValueChange(ordered);
      return;
    }
    trigger.current?.focus();
    flushSync(() => { setOpen(false); });
    props.onValueChange(option.value);
  };

  return <span className={["projects-ui__select", className].filter(Boolean).join(" ")}>
    <select {...nativeProps} ref={attachNative} className="projects-ui__native-field"
      value={value} multiple={multiple} disabled={disabled} tabIndex={-1} aria-hidden="true"
      onFocus={event => { onFocus?.(event); trigger.current?.focus(); }}
      onInvalid={event => {
        onInvalid?.(event);
        // Suppress the browser's bubble on the visually hidden field. Its native
        // validity still blocks submit; keyboard users land on the visible UI.
        event.preventDefault();
        const form = event.currentTarget.form;
        const firstInvalid = form === null ? event.currentTarget : Array.from(form.elements).find(element => {
          const field = element as HTMLInputElement;
          return field.willValidate && !field.validity.valid;
        });
        if (firstInvalid === event.currentTarget) trigger.current?.focus();
      }}
      onChange={event => {
        if (props.multiple) props.onValueChange(Array.from(event.currentTarget.selectedOptions, option => option.value));
        else props.onValueChange(event.currentTarget.value);
      }}>
      {children}
    </select>
    <Menu open={open && !disabled} portal minWidthFromAnchor autoFocus className="projects-ui__select-anchor"
      items={accessibleItems} selectedIds={selected.map(option => option.id)} onSelect={select} onClose={close}
      anchor={<Button ref={trigger} variant="outline" size="md" disabled={disabled}
        className="projects-ui__select-trigger" aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]} aria-describedby={describedBy}
        aria-invalid={props["aria-invalid"]} aria-haspopup="menu" aria-expanded={open}
        title={props.title} onClick={() => { if (!isDisabled()) setOpen(current => !current); }}
        onKeyDown={event => {
          if (!open && !isDisabled() && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault(); setOpen(true);
          }
        }}>
        <span className="projects-ui__select-value">{label || "\u00a0"}</span>
        <IconChevronDownOutlineRegular />
      </Button>} />
    <span id={selectionId} className="projects-ui__visually-hidden" role={multiple ? "status" : undefined}
      aria-live={multiple ? "polite" : undefined} aria-atomic={multiple ? "true" : undefined}>{selectionSummary}</span>
  </span>;
});
