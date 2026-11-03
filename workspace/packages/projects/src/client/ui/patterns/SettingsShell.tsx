import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconAction, IconCloseOutlineRegular, Modal, SegmentedTabs } from "../primitives.tsx";

export interface SettingsNavigation<Id extends string> { id: Id; label: string; icon?: ReactNode }
export interface SettingsShellProps<Id extends string> {
  open: boolean;
  title: string;
  projectName?: string;
  navigation: readonly [SettingsNavigation<Id>, ...SettingsNavigation<Id>[]];
  activeId: Id;
  onNavigate: (id: Id) => void;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Project-scoped settings layout inside the host's modal/focus/Escape layer. */
export function SettingsShell<Id extends string>({ open, title, projectName, navigation, activeId,
  onNavigate, onClose, closeLabel, children, footer }: SettingsShellProps<Id>) {
  const navigationId = useId();
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 699px)").matches : false);
  const desktopNavigation = useRef<HTMLElement>(null);
  const compactNavigation = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (body.current !== null) body.current.scrollTop = 0;
  }, [activeId]);
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 699px)");
    const update = () => { setNarrow(query.matches); };
    update();
    query.addEventListener("change", update);
    return () => { query.removeEventListener("change", update); };
  }, []);
  useLayoutEffect(() => {
    const hiddenNavigation = narrow ? desktopNavigation.current : compactNavigation.current;
    const visibleNavigation = narrow ? compactNavigation.current : desktopNavigation.current;
    if (hiddenNavigation?.contains(hiddenNavigation.ownerDocument.activeElement)) {
      visibleNavigation?.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]')?.focus();
    }
  }, [narrow]);
  const tabId = (id: Id) => `${navigationId}-${id}-tab`;
  const panelId = (id: Id) => `${navigationId}-${id}-panel`;
  const tabItem = (item: SettingsNavigation<Id>) => ({ value: item.id, label: item.label,
    id: tabId(item.id), panelId: panelId(item.id) });
  return <Modal open={open} headless title={title} onClose={onClose} className="projects-ui__settings">
    <nav ref={desktopNavigation} className="projects-ui__settings-nav" aria-label={title} hidden={narrow}>
      <div>
        <div className="projects-ui__settings-nav-title">{title}</div>
        {projectName !== undefined && <div className="projects-ui__settings-project-name">{projectName}</div>}
      </div>
      <div className="projects-ui__settings-nav-list">{navigation.map(item => <button key={item.id} type="button"
        className="projects-ui__settings-nav-item" aria-current={item.id === activeId ? "page" : undefined}
        data-modal-autofocus={!narrow && item.id === activeId ? "" : undefined}
        data-active={item.id === activeId || undefined} onClick={() => { onNavigate(item.id); }}>
        {item.icon !== undefined && <span className="projects-ui__settings-nav-icon" aria-hidden="true">{item.icon}</span>}{item.label}</button>)}</div>
    </nav>
    <div className="projects-ui__settings-main">
      <header className="projects-ui__settings-head">
        <div>{narrow ? title : navigation.find(item => item.id === activeId)?.label}</div>
        <IconAction tone="primary" className="projects-ui__settings-close" aria-label={closeLabel ?? title}
          data-modal-autofocus={narrow ? "" : undefined} icon={<IconCloseOutlineRegular />} onClick={onClose} />
      </header>
      <nav ref={compactNavigation} className="projects-ui__settings-tabs" aria-label={title} hidden={!narrow}>
        <SegmentedTabs className="projects-ui__settings-tab-items" label={title} value={activeId}
          items={[tabItem(navigation[0]), ...navigation.slice(1).map(tabItem)]} onChange={onNavigate} />
      </nav>
      {navigation.filter(item => item.id !== activeId).map(item => <div key={item.id} hidden
        role="tabpanel" id={panelId(item.id)} aria-labelledby={tabId(item.id)} />)}
      {/* Responsive navigation only changes presentation; keep one mounted draft/guard owner. */}
      <div ref={body} className="projects-ui__settings-body" role="tabpanel" id={panelId(activeId)} aria-labelledby={tabId(activeId)}>{children}</div>
      {footer !== undefined && <footer className="projects-ui__settings-footer">{footer}</footer>}
    </div>
  </Modal>;
}
