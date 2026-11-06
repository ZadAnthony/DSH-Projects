/** The only hand-written Projects stylesheet; host primitives own their visuals. */
export const projectsUiStyles = `
.dsh-projects, .dsp-theme, .projects-ui__settings, .projects-ui__stock-aside, .projects-ui__modal, .projects-ui__tool-card, .projects-library-reader, .projects-library, .dsh-usage-panel, .dsh-schedule-panel, .dsh-overview-panel { --projects-key-text-size: max(12px, var(--dsh-content-font-size-secondary, 13px)); --projects-key-text-leading: max(18px, calc(20px + var(--dsh-content-font-delta-secondary, 0px))); }
.projects-ui__native-actions { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; padding: 4px 16px; }
.projects-ui__preset-seat { display: flex; flex: none; align-items: center; justify-content: center; min-width: 0; padding: 8px 0; }
.projects-ui__native-actions:empty, .projects-ui__preset-seat:empty { display: none; }
/* Stock-owned non-modal reader shells retain their existing native-domain geometry. */
.projects-ui__stock-aside { position: absolute; inset: 0 0 0 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border-left: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }
.projects-ui__stock-aside[hidden] { display: none; }
.projects-ui__stock-aside--recorded { width: min(900px, 96%); z-index: 21; }
.projects-ui__stock-aside--child { width: min(720px, 92%); z-index: 20; }
.projects-ui__stock-head { box-sizing: border-box; display: flex; flex: none; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 8px; border-bottom: .5px solid var(--dsw-alias-border-l3); }
.projects-ui__stock-title { display: block; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.projects-ui__stock-pane, .projects-ui__stock-pane-body { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.projects-ui__stock-pane { height: 100%; overflow: hidden; }
.projects-ui__stock-pane-body { overflow: hidden; }
.projects-ui__stock-readonly { flex: none; margin: 0; padding: 8px 16px; color: var(--dsw-alias-label-secondary); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); overflow-wrap: anywhere; }
.projects-ui__stock-plan { inset: 8px 8px 8px auto; box-sizing: border-box; width: min(620px, 95%); z-index: 30; border: .5px solid var(--dsw-alias-border-l4); border-radius: 12px; box-shadow: var(--dsw-elevation-prominent); }
.projects-ui__stock-plan-content { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 16px; overflow-wrap: anywhere; overscroll-behavior: contain; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.dsh-projects__project-row-shell { display: flex; align-items: center; gap: 8px; }
.dsh-projects__project-row-shell > .dsh-projects__project-card { flex: 1; min-width: 0; }
.dsh-projects__project-row-shell .projects-ui__action-menu-trigger { flex: none; }
.dsh-projects__filter-panel > .dsh-projects__project-list-menu { display: block; width: 100%; min-width: 0; }
/* Page, list, workspace and right-panel compositions share the host's text axis. */
.dsh-projects { width: 100%; min-width: 0; container: projects-workspace / inline-size; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.dsh-projects *, .projects-ui__settings * { box-sizing: border-box; }
.dsh-projects [hidden], .projects-ui__settings [hidden] { display: none !important; }
.dsh-projects__list-page { flex: 1; min-height: 0; overflow: auto; padding: 0 clamp(24px, 4vw, 48px); padding-bottom: 48px; }
.dsh-projects__list-column { display: flex; flex-direction: column; gap: 32px; width: 100%; max-width: 960px; margin: 0 auto; }
.dsh-projects__page-head, .dsp-settings-object-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dsh-projects__page-head { flex-wrap: wrap; padding-top: 28px; }
[data-platform='darwin'] .dsh-projects__list-column:not(.dsh-projects__deletion-page) > .dsh-projects__page-head { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dsh-projects__page-head > div, .dsp-settings-usage, .dsp-settings-object-heading > div, .dsp-deletion-details, .dsh-projects__filter-panel, .projects-ui__settings-model-control, .dsp-memory-detail, .dsh-overview-reading, .dsh-schedule-header > div, .dsh-projects__session-row, .dsh-projects-communication__context { min-width: 0; }
.dsh-projects__page-head h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.dsh-projects__copy { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); }
.dsh-projects__list-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; }
.dsh-projects__search { display: flex; align-items: center; gap: 8px; width: min(320px, 100%); min-width: 0; }
.dsh-projects__search > :not(button), .dsh-projects__workspace-picker > :not(button), .dsh-overview-heading h2, .projects-ui__tool-card-heading { flex: 1; min-width: 0; }
.dsh-projects__search > button, .dsh-projects__project-ident > button, .dsh-projects__project-actions, .projects-library-remove { flex: none; }
.dsh-projects__projects { display: flex; flex-direction: column; gap: 2px; }
.projects-ui__list-row { position: relative; gap: 14px; min-width: 0; min-height: 64px; margin: 0; padding: 8px; border-radius: 20px; background: transparent; }
.projects-ui__list-row:hover, .projects-ui__list-row:focus-within, .dsh-schedule-item-row:hover, .dsh-schedule-item-row:focus-within { background: var(--dsw-alias-interactive-bg-hover); }
.projects-ui__list-row:focus-visible, .projects-ui__textarea:focus-visible, .projects-ui__settings-nav-item:focus-visible, .dsh-projects-communication__context > summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.projects-ui__list-row:disabled, .projects-ui__textarea:disabled { opacity: .4; cursor: not-allowed; }
.projects-ui__list-row-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 48px; height: 48px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 16px; background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
.projects-ui__list-row-main, .projects-library-entry-copy { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.projects-ui__list-row-end { flex: none; }
.projects-ui__list-row--compact { min-height: 48px; gap: 12px; border-radius: 12px; }
.projects-ui__list-title, .dsh-projects__project-name { display: block; font-weight: 500; }
.projects-ui__list-description, .dsh-projects__project-workspace { display: block; color: var(--dsw-alias-label-secondary); }
.dsh-projects__project-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; color: var(--dsw-alias-label-secondary); }
.dsh-projects__entry-arrow { display: inline-flex; flex: none; color: var(--dsw-alias-label-secondary); transform: rotate(180deg); }
.dsh-projects__project-head { align-items: flex-start; justify-content: space-between; gap: 8px; min-height: 76px; padding: 10px 28px 0 20px; padding-inline-start: max(20px, var(--dsh-frame-leading-clearance, 0px)); }
.dsh-projects__project-ident { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.dsh-projects__project-title { flex: 1; margin: 0; font-size: inherit; line-height: calc(20px + var(--dsh-content-font-delta, 0px)); font-weight: 500; }
.dsh-projects__project-actions, .dsh-projects__operation-result { display: flex; align-items: center; gap: 8px; }
.projects-ui__icon-action { width: 28px; padding: 0; flex: none; color: var(--dsw-alias-label-secondary); }
.projects-ui__icon-action--primary { color: var(--dsw-alias-label-primary); }
.projects-ui__icon-action.dsh-projects__overview-trigger[aria-expanded="true"]:not(:disabled) { background: var(--dsw-alias-button-ghost-active-fill); color: var(--dsw-alias-label-primary); }
.projects-ui__icon-action.dsh-projects__overview-trigger[aria-expanded="true"]:hover:not(:disabled) { background: var(--dsw-alias-button-ghost-active-hover); }
.projects-ui__icon-action.dsh-projects__overview-trigger[aria-expanded="true"]:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.projects-ui__action-menu-trigger[aria-expanded="true"]:where(:not(:disabled)) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-projects__overview-icon { transform: scaleX(-1); }
.dsh-projects__workspace, .dsh-projects__conversations { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; }
.dsh-projects__workspace { position: relative; isolation: isolate; flex: 1; grid-template-rows: auto minmax(0, 1fr); }
.dsh-projects__workspace[data-overview='inline'] { grid-template-columns: minmax(0, 1fr) var(--dsh-projects-overview-width, 360px); }
.dsh-projects__workspace[data-overview='stacked'] { grid-template-rows: auto minmax(max(320px, 16lh), 1fr) minmax(max(200px, 10lh), 45%); overflow-y: auto; overscroll-behavior-y: contain; }
.dsh-projects__conversations { grid-column: 1; grid-row: 2; }
.dsh-projects__workspace[data-layout='split'] .dsh-projects__conversations { grid-template-columns: minmax(680px, 1fr) minmax(480px, 560px); gap: 24px; }
.dsh-projects__conversation-seat, .dsh-projects__overview-body { flex: 1; min-width: 0; overflow: hidden; }
.dsh-projects__conversation-heading.dsh-projects__conversation-heading { display: flex; flex: none; align-items: center; flex-wrap: nowrap; gap: 8px; min-height: 44px; padding: 8px 16px; }
.dsh-projects__conversation-heading > .dsh-projects__conversation-role { flex: none; align-self: flex-start; margin-top: 5px; padding: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dsh-projects__execution-controls { display: flex; flex: 0 1 auto; align-items: center; gap: 4px; min-width: 0; max-width: 100%; }
.dsh-projects__session-options { flex: none; }
.dsh-projects__execution-selector { flex: 0 1 auto; min-width: 0; max-width: 440px; }
.dsh-projects__execution-trigger.dsh-projects__execution-trigger { justify-content: flex-start; min-width: 0; max-width: 100%; min-height: 28px; height: auto; padding: 4px 8px; font-size: var(--dsh-content-font-size, 14px); line-height: calc(20px + var(--dsh-content-font-delta, 0px)); font-weight: 400; text-align: left; }
.dsh-projects__execution-trigger[aria-expanded='true']:not(:disabled) { background: var(--dsw-alias-button-ghost-active-fill); }
.dsh-projects__execution-current-name { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-projects__execution-trigger > svg { flex: none; }
.dsh-projects__execution-menu.dsh-projects__execution-menu { width: min(440px, calc(100vw - 32px)); max-height: min(480px, calc(100dvh - 96px)); overflow-y: auto; }
.dsh-projects__execution-menu [role='menuitem'] > span { white-space: normal; overflow-wrap: anywhere; }
.dsh-projects__execution-directory { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 16px; overscroll-behavior: contain; }
.dsh-projects__conversation-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; grid-column: 1; grid-row: 1; min-width: 0; padding: 8px 16px; }
.dsh-projects__conversation-tabs { flex: none; min-width: 0; max-width: 100%; }
.dsh-projects__conversation-tab-list, .dsh-projects__conversation-focus-actions { width: fit-content; min-width: 240px; max-width: 100%; }
.dsh-projects__conversation-focus-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; gap: 0; padding: 4px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
.dsh-projects__conversation-focus-actions > button { height: 34px; padding: 0 12px; border-radius: var(--dsw-radius-md); font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.dsh-projects__conversation-focus-actions > button[aria-pressed='true'] { color: var(--dsw-alias-label-primary); font-weight: 600; background: var(--dsw-alias-bg-layer-3); box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l3); }
.dsh-projects__conversation-title { flex: 1; }
.dsh-projects__overview-panel { position: relative; flex: none; width: var(--dsh-projects-overview-width, 360px); max-width: 100%; min-width: 0; overflow: hidden; border-left: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); }
.dsh-projects__overview-panel[data-mode='inline'] { grid-column: 2; grid-row: 1 / -1; }
.dsh-projects__overview-panel[data-mode='stacked'] { grid-column: 1; grid-row: 3; width: 100%; border-left: 0; border-top: 0.5px solid var(--dsw-alias-border-l4); }
.dsh-projects__overview-resizer { position: absolute; inset-block: 0; left: 0; z-index: 1; width: 8px; cursor: col-resize; touch-action: none; user-select: none; }
.dsh-projects__overview-resizer::before { content: ''; position: absolute; inset-block: 0; left: 0; width: 1px; background: transparent; }
.dsh-projects__overview-resizer::after { content: ''; position: absolute; top: 50%; left: 3px; width: 2px; height: 32px; margin-top: -16px; border-radius: 2px; background: var(--dsw-alias-border-l3); }
.dsh-projects__overview-resizer:hover::before, .dsh-projects__overview-resizer:focus-visible::before, .dsh-projects__overview-resizer[data-dragging='true']::before,
.dsh-projects__overview-resizer:hover::after, .dsh-projects__overview-resizer:focus-visible::after, .dsh-projects__overview-resizer[data-dragging='true']::after { background: var(--dsw-alias-state-business-primary); }
.dsh-projects__overview-resizer:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dsh-projects__overview-resizer[aria-disabled='true'] { cursor: default; }
.dsh-projects__overview-head { min-height: 44px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-projects__overview-head h2, .dsh-projects__side-title { flex: 1; min-width: 0; margin: 0; font-size: inherit; font-weight: 500; overflow-wrap: anywhere; }
.dsh-projects__side-tabs { align-items: center; padding: 8px 12px; }
.dsh-projects__side-tabs > * { min-width: 0; max-width: 100%; }
.dsh-projects__side-body { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 16px; overscroll-behavior: contain; }
.dsh-projects__side-body--flush, .dsh-projects__side-body--reader { display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.dsh-projects__side-body--flush > *, .dsh-projects__side-body--reader > * { min-height: 0; }
.dsh-projects__side-body--history-reader { display: flex; flex-direction: column; overflow: auto; padding: 0; }
.dsh-projects__history-reading-meta { flex: none; min-width: 0; padding: 16px; }
.dsh-projects__history-reading-content { flex: 1; min-height: 4lh; min-width: 0; overflow: hidden; }
.dsh-projects__history-record-reader, .dsh-projects__history-record-reader > article { min-width: 0; max-width: 100%; }
.dsh-projects__history-record-meta { display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.dsh-projects__history-record-meta > strong { font-size: var(--dsh-content-font-size, 14px); line-height: 22px; font-weight: 500; }
.dsh-projects__history-record-byline { display: flex; flex-wrap: wrap; gap: 4px 12px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-projects__history-record-notice { margin: 12px 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.dsh-projects__history-record-details { margin-top: 20px; padding-top: 12px; border-top: .5px solid var(--dsw-alias-border-l3); overflow-wrap: anywhere; }
.dsh-projects__history-record-details > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; }
.dsh-projects__history-record-details h3 { margin: 16px 0 8px; font-size: 13px; font-weight: 500; }
.dsh-projects__overview-head, .dsh-projects__side-head { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 16px; }
.projects-ui__list-title, .dsh-projects__project-name { font-size: var(--dsh-content-font-size, 14px); line-height: calc(20px + var(--dsh-content-font-delta, 0px)); }
.dsh-projects__copy, .dsh-projects__lifecycle-report, .dsh-projects__readonly, .dsp-settings-help, .dsp-settings-locations dt, .dsp-settings-related, .dsp-deletion-error, .projects-ui__settings-body :is(.dsp-settings-description, .dsp-settings-object-heading p), .projects-ui__settings-section-intro { font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
.projects-ui__list-description, .dsh-projects__project-workspace { font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px)); }
.dsh-projects__project-meta, .dsh-projects__project-state, .dsh-projects__eyebrow, .dsh-projects__hint, .dsh-projects__history-meta, .dsh-projects__reading-context, .dsp-deletion-state, .dsp-deletion-identity, .dsp-deletion-note, .dsp-deletion-identity code, .dsp-deletion-results .dsp-deletion-stages, .dsp-deletion-stages>li, .dsp-deletion-attachment-status, .dsp-deletion-details, .dsp-deletion-member h5, .dsh-schedule-run > header { font-size: 12px; line-height: 18px; }

@container projects-workspace (max-width: 560px) {
  .dsh-projects__list-tools { align-items: stretch; flex-direction: column; }
  .dsh-projects__search { width: 100%; }
  .dsh-projects__project-meta { max-width: 96px; overflow-wrap: anywhere; }
}

/* Persistent source/deletion results and existing session forms. */
.dsh-projects__eyebrow { margin: 0 0 4px; color: var(--dsw-alias-label-secondary); }
.dsh-projects__lifecycle-report { flex: none; margin: 12px 16px; border: 0.5px solid var(--dsw-alias-border-l3); overflow-wrap: anywhere; }
.dsh-projects__lifecycle-report p { margin: 0 0 4px; }
.dsh-projects__lifecycle-report ul { padding-left: 16px; }
.dsh-projects__field { min-width: 0; color: var(--dsw-alias-label-primary); }
/* Keep creation's longer prose form inside the host overlay; footer actions stay reachable. */
.dsh-projects__create-dialog { width: min(560px, 100%); max-height: 100%; font-family: var(--dsw-font-family); font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }
.dsh-projects__create-content { min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; }
.dsh-projects__create-dialog > :last-child { flex-shrink: 0; }
.dsh-projects__create-content h2 { font-size: 18px; line-height: 26px; }
.dsh-projects__create-form.dsp-form-section { gap: 20px; padding-bottom: 4px; }
.dsh-projects__create-form .projects-ui__textarea { min-height: 152px; }
.dsh-projects__create-form .dsh-projects__hint { font-weight: 400; }
.dsh-projects__readonly { flex: none; margin: 0; padding: 8px 16px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-projects__project-main, .dsh-projects__session-chat { flex: 1 1 0; min-width: 0; overflow: hidden; }
.dsh-projects__overview-block { margin-bottom: 16px; min-width: 0; }
.dsh-projects__overview-block:last-child { margin-bottom: 0; }
.dsh-projects__overview-block h2, .dsh-projects__form h2, .dsp-deletion-results.dsp-deletion-results>h2, .dsp-deletion-results.dsp-deletion-results>h3 { margin: 0; font-weight: 500; }
.dsh-projects__overview-value { margin: 0; }
.dsh-projects__record-list, .dsh-projects__history { display: grid; gap: 16px; }
.dsh-projects__record { min-width: 0; overflow-wrap: anywhere; }
.dsh-projects__source-item + .dsh-projects__source-item { margin-top: 16px; }
.dsh-projects__session-list { display: grid; gap: 2px; margin-top: 16px; }
.dsh-projects__confirmation { width: 440px; max-width: 100%; }
.dsh-projects__history-meta { overflow-wrap: anywhere; }
.dsh-projects__deletion-results { margin-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-projects__deletion-result { margin: 12px 0; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); overflow-wrap: anywhere; }
.dsh-projects__deletion-result h4, .dsp-settings-saved-prose p, .dsp-deletion-results p, .dsp-deletion-confirmation p, .dsh-overview-row dd, .projects-ui__tool-card p:not(:where(.projects-library-document *)) { margin: 0; }
.dsh-projects__deletion-result ul { padding-left: 16px; color: var(--dsw-alias-label-secondary); }
.dsh-projects__form { display: grid; gap: 16px; min-width: 0; margin: 16px 0; }
.dsh-projects__session-head { display: flex; flex-direction: column; align-items: stretch; gap: 8px; margin-bottom: 16px; }
.dsh-projects__session-actions { justify-content: space-between; }
.dsh-projects__form-actions, .projects-library-add-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.dsh-projects__form-actions { padding-top: 8px; }
.dsh-projects__session-name { display: block; font-weight: 500; overflow-wrap: anywhere; }
/* Shared settings form compositions retained from P2. */
.dsp-settings-section, .projects-feature-settings { min-width: 0; margin: 0; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsp-settings-section > h3, .projects-feature-settings > h2 { margin: 0 0 12px; font-weight: 500; }
.dsp-settings-description, .projects-feature-settings > p { margin: 8px 0 16px; color: var(--dsw-alias-label-secondary); }
.dsp-settings-form { display: grid; gap: 12px; max-width: 760px; }
.projects-feature-settings fieldset { display: grid; gap: 12px; min-width: 0; margin: 0; padding: 0; border: 0; }
.dsp-settings-help { margin: 12px 0 16px; color: var(--dsw-alias-label-secondary); }
.dsp-settings-help summary, .dsp-memory-source-locator summary, .dsh-projects__readonly > summary { cursor: pointer; min-height: 28px; }
.dsp-settings-help summary { width: fit-content; max-width: 100%; }
.dsp-settings-help p { margin: 12px 0 0; }
.dsp-settings-help summary:focus-visible, .dsp-memory-source-locator summary:focus-visible, .projects-library-refadd > summary:focus-visible, .projects-library-readingdetails > summary:focus-visible, .dsh-overview-reading > summary:focus-visible, .dsh-usage-details > summary:focus-visible, .dsh-schedule-details > summary:focus-visible, .dsh-usage-table:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; border-radius: 4px; }
.dsp-settings__session-select { max-width: 540px; }
.dsp-settings-locations { display: grid; grid-template-columns: 154px minmax(0, 1fr); gap: 16px; margin: 16px 0; }
.dsp-settings-locations dd { margin: 0; }
.dsp-settings-model-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(160px, 1fr); gap: 12px; max-width: 760px; }
.dsp-settings-model-grid > :is(p, button, .dsp-settings-actions), .projects-library-location, .projects-library-add-actions, .dsh-projects__history-form-actions { grid-column: 1 / -1; }
.dsp-settings-model-grid > button { justify-self: start; }

.dsp-settings-object-heading p { margin: 8px 0 12px; color: var(--dsw-alias-label-secondary); }
.dsp-settings-saved-value { margin: 12px 0; }
.dsp-settings-saved-prose { margin: 16px 0; }
.dsh-projects__overview-value, .dsp-settings-locations dd, .dsp-settings-saved-value, .dsp-settings-saved-prose { color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 700px) {
  .dsp-settings-locations { grid-template-columns: 1fr; gap: 4px; }
  .dsp-settings-locations dd { margin-bottom: 12px; }
  .dsp-settings-model-grid { grid-template-columns: 1fr; }
  .dsp-settings-object-heading { flex-wrap: wrap; gap: 4px; }
}

/* Reading return context remains shared by both existing reader chains. */
.dsh-projects__reading-context { justify-content: space-between; padding: 8px 16px; background: var(--dsw-alias-bg-layer-1); border-bottom: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); }
.dsh-projects__reading-context > span { min-width: 0; overflow-wrap: anywhere; }
.dsh-projects__source-location { margin-top: 12px; }

/* Existing deletion confirmation and multi-axis receipts remain unchanged. */
.dsp-deletion-results.dsp-deletion-results { display: grid; gap: 16px; min-width: 0; margin-top: 16px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsp-deletion-results .dsh-projects__deletion-result { display: grid; gap: 12px; min-width: 0; margin: 0; }
.dsp-deletion-results .dsh-projects__deletion-result[data-state='partial'] { border-inline-start: 0.5px solid var(--dsw-alias-state-error-primary); }
.dsp-deletion-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; min-width: 0; }
.dsp-deletion-heading h4, .dsp-deletion-member h5 { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.dsp-deletion-identity, .dsp-deletion-note { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsp-deletion-identity code { white-space: normal; overflow-wrap: anywhere; }
.dsp-deletion-results .dsp-deletion-stages { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; color: var(--dsw-alias-label-primary); }
.dsp-deletion-stages>li, .dsp-deletion-attachment-status { display: grid; grid-template-columns: minmax(0,1fr) minmax(110px,.8fr); gap: 8px 16px; padding: 8px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); min-width: 0; }
.dsp-deletion-stages strong, .dsp-deletion-attachment-status strong, .dsh-overview-row > strong { font-weight: 500; overflow-wrap: anywhere; }
.dsp-deletion-details>summary, .dsh-projects-communication__context > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); padding: 4px 0; min-height: 28px; box-sizing: border-box; }
.dsp-deletion-details>summary>strong { font-weight: 500; color: var(--dsw-alias-label-primary); margin-inline-start: 12px; }
.dsp-deletion-details[open]>summary { margin-bottom: 8px; }
.dsp-deletion-details>ul { margin: 0; padding-inline-start: 16px; }
.dsp-deletion-member { display: grid; gap: 8px; min-width: 0; }
.dsp-deletion-member+.dsp-deletion-member, .projects-library-readingdetails[open] > :not(summary), .dsh-overview-reading[open] > :not(summary), .dsh-usage-details[open] > :not(summary), .dsh-schedule-details[open] > :not(summary), .projects-library-detailcontent, .dsh-projects-communication__part + .dsh-projects-communication__part, .dsh-projects-communication__context[open] > :not(summary) { margin-top: 12px; }
.dsp-deletion-error, .dsh-overview-source-heading, .dsh-overview-shortcuts { display: grid; gap: 4px; min-width: 0; }
.dsp-deletion-project-status { padding: 12px 16px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); }
.dsp-deletion-project>.dsp-deletion-results { margin: 0; padding-top: 16px; }
.dsp-deletion-confirmation.dsp-deletion-confirmation { display: grid; gap: 16px; max-width: 680px; min-width: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsp-deletion-warning, .projects-library-entry-copy strong { font-weight: 500; }
.dsp-deletion-scope, .dsp-form-section { display: grid; gap: 16px; min-width: 0; }
.dsp-deletion-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
@media (max-width: 620px) {
  .dsp-deletion-stages>li, .dsp-deletion-attachment-status { grid-template-columns: minmax(0,1fr); gap: 4px; }
  .dsp-deletion-actions { justify-content: flex-start; }
  .dsp-deletion-details>summary>strong { display: block; margin-inline-start: 0; }
}

/* Unmigrated settings/results use inherited body and explicit secondary/metadata roles. */
.dsp-theme, .dsh-projects, .dsh-projects__form h2, .dsh-projects__overview-block h2, .dsp-deletion-results.dsp-deletion-results, .dsp-deletion-results.dsp-deletion-results>h2, .dsp-deletion-results.dsp-deletion-results>h3, .dsp-deletion-heading h4, .dsp-deletion-project-status, .dsp-deletion-confirmation.dsp-deletion-confirmation { font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }
.dsp-deletion-details>summary, .dsp-deletion-details>ul { line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }

/* Shared field and state patterns; these are the host's missing compositions. */
.dsh-projects, .dsp-theme, .dsh-project-feedback { font-family: var(--dsw-font-family); }
.projects-ui__field, .dsp-field { display: grid; align-content: start; gap: 8px; min-width: 0; font-weight: 500; }
.projects-ui__field > small, .dsp-field > small { font-weight: 400; }
.projects-ui__field-error, .projects-ui__field-status { margin: 0; font-size: 12px; line-height: 18px; font-weight: 400; overflow-wrap: anywhere; }
.projects-ui__field-error :is(.projects-ui__state-title, .projects-ui__state-description) { color: inherit; font-size: inherit; line-height: inherit; }
.projects-ui__textarea { box-sizing: border-box; display: block; width: 100%; min-width: 0; min-height: 96px; padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); resize: vertical; transition: border-color .2s ease; }
.projects-ui__textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
.projects-ui__textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
.projects-ui__select { position: relative; display: inline-flex; width: 100%; min-width: 0; }
.projects-ui__select-anchor, .dsp-memory-search { width: 100%; min-width: 0; }
.projects-ui__select-trigger { width: 100%; min-width: 0; justify-content: space-between; height: 32px; padding: 0 8px; }
.projects-ui__native-field { inset: 0 auto auto 0; margin: 0; padding: 0; border: 0; opacity: 0; pointer-events: none; }
.projects-ui__empty, .projects-ui__error, .projects-ui__tool-card { display: flex; flex-direction: column; min-width: 0; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); overflow-wrap: anywhere; }
.projects-ui__empty, .projects-ui__error { align-items: center; gap: 12px; padding: 48px 20px; text-align: center; }
.projects-ui__state-icon { display: inline-flex; color: var(--dsw-alias-label-tertiary); }
.projects-ui__state-icon > svg { width: 32px; height: 32px; }
.projects-ui__state-title { margin: 0; font-weight: 500; }
.projects-ui__state-description { margin: 0; color: var(--dsw-alias-label-secondary); }
.projects-ui__state-actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.projects-ui__loading { display: grid; gap: 12px; width: 100%; min-width: 0; padding: 16px 0; color: var(--dsw-alias-label-secondary); }
.projects-ui__skeleton { display: block; width: 100%; height: 12px; border-radius: 4px; background: var(--dsw-alias-bg-skeleton); animation: projects-ui-pulse 2s ease-in-out infinite; }
@keyframes projects-ui-pulse { 50% { opacity: .4; } }

/* The rc.3 settings page is not public: reproduce its documented shell only. */
.projects-ui__settings.projects-ui__settings { display: flex; flex-direction: row; gap: 0; width: 800px; height: min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px)))); max-width: calc(100vw - 48px); padding: 0; border-radius: 28px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-prominent); font-family: var(--dsw-font-family); font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.projects-ui__settings-nav { flex: none; gap: 18px; width: 188px; padding: 22px 12px 0; box-sizing: border-box; overflow-y: auto; }
.projects-ui__settings-nav-title { padding: 0 12px; font-size: 16px; line-height: 24px; font-weight: 500; }
.projects-ui__settings-nav-list { gap: 4px; overflow-y: auto; }
.projects-ui__settings-project-name { overflow-wrap: anywhere; }
.projects-ui__settings-nav-item { background: transparent; gap: 8px; flex: none; justify-content: flex-start; min-height: 40px; height: auto; padding: 9px 16px 9px 12px; border-radius: 12px; }
.projects-ui__list-row, .projects-ui__settings-nav-item { border: 0; color: inherit; font: inherit; cursor: pointer; display: flex; align-items: center; width: 100%; text-align: left; }
.projects-ui__settings-nav-item:hover { background: var(--dsw-specific-sidebar-nav-item-hover); }
.projects-ui__settings-nav-item[data-active='true'] { background: var(--dsw-specific-sidebar-nav-item-active); }
.projects-ui__settings-main { flex: 1; min-width: 0; }
.dsh-projects__conversation-seat, .dsh-projects__overview-body, .dsh-projects__overview-panel, .dsh-projects__project-main, .dsh-projects__session-chat, .projects-ui__settings-nav, .projects-ui__settings-nav-list, .projects-ui__settings-main { display: flex; flex-direction: column; min-height: 0; }
.projects-ui__settings-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; height: 54px; padding: 20px 14px 8px 10px; box-sizing: border-box; }
.projects-ui__settings-head > div { font-size: 16px; line-height: 24px; font-weight: 500; }
.projects-ui__list-title, .dsh-projects__project-name, .projects-ui__list-description, .dsh-projects__project-workspace, .dsh-projects__project-title, .dsh-projects__conversation-title, .projects-ui__select-value, .projects-ui__settings-head > div { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.projects-ui__settings-close { flex: none; margin-left: auto; }
.projects-ui__settings-body { flex: 1; min-height: 0; min-width: 0; padding: 0 24px 24px; overflow-y: auto; overscroll-behavior: contain; }
.projects-ui__settings-footer { flex: none; justify-content: flex-end; padding: 16px 24px 24px; }
.projects-ui__settings-footer > span { margin-right: auto; overflow-wrap: anywhere; }
.projects-ui__settings-body .projects-ui__settings-section-heading, .projects-ui__settings-body .projects-feature-settings .dsp-settings-object-heading h3 { margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; }
.dsh-schedule-modal { width: min(440px, 100%); max-height: 100%; }
.dsh-schedule-modal-content, .dsh-schedule-manager-content { min-height: 0; overflow: auto; }

.projects-ui__settings-tabs { display: none; flex: none; min-width: 0; padding: 0 16px 12px; overflow-x: auto; }
.projects-ui__settings-tab-items { width: 100%; min-width: max-content; }
.projects-ui__settings-content { display: flex; flex-direction: column; min-width: 0; max-width: 760px; }
.projects-ui__settings-main { container: projects-settings / inline-size; }
.dsp-settings-basics, .dsp-settings-models { display: grid; gap: 16px; }
.dsp-settings-model-row { display: grid; grid-template-columns: minmax(120px, 160px) minmax(0, 1fr); gap: 16px; align-items: start; }
.dsp-settings-model-label { margin: 0; font-size: inherit; font-weight: 500; }
.dsp-settings-model-label p { margin: 4px 0 0; font-size: var(--projects-key-text-size); line-height: var(--projects-key-text-leading); font-weight: 400; color: var(--dsw-alias-label-secondary); }
.dsp-settings-inline-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 20px; font-size: var(--projects-key-text-size); line-height: var(--projects-key-text-leading); }
.dsp-settings-inline-status:empty { display: none; }
.dsp-settings-session-row { display: grid; grid-template-columns: minmax(100px, 160px) minmax(0, 1fr); align-items: center; gap: 16px; }
.dsp-settings-location { display: grid; gap: 8px; }
.dsp-settings-location .dsp-settings-saved-value { margin: 0; }
.dsp-settings-direct-instructions { min-width: 0; }
.dsp-settings-models .projects-feature-settings { padding: 0; border: 0; }
.projects-ui__settings-body :is(.dsp-settings-basics, .dsp-settings-models) > .projects-ui__settings-section-heading,
.projects-ui__settings-body .dsp-settings-models .dsp-settings-object-heading h3 { font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }
@container projects-settings (max-width: 520px) {
  .dsp-settings-model-row, .dsp-settings-session-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
}
.projects-ui__settings-section-intro { margin: 0 0 12px; color: var(--dsw-alias-label-secondary); }
.projects-ui__settings-nav-icon { display: inline-flex; flex: none; }
@media (max-width: 699px) {
  .projects-ui__settings-nav { display: none; }
  .projects-ui__settings-tabs { display: block; }
  .projects-ui__settings-body { padding: 0 16px 16px; }
  .projects-ui__settings-footer { padding: 16px; }
}

@media (prefers-reduced-motion: reduce) {
  .projects-ui__textarea { transition: none; }
  .projects-ui__skeleton { animation: none; }
}


/* P3 leaf compositions share body, metadata, action rows and disclosure treatment. */
.projects-memory, .projects-library, .projects-library-reader, .projects-library-reading, .dsh-overview-panel, .dsh-overview-board, .dsh-usage-panel, .dsh-schedule-panel, .dsh-schedule-form { min-width: 0; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }
.dsp-memory-reading, .dsp-memory-edit-form fieldset, .dsh-overview-board, .dsh-overview-content, .dsh-usage-panel, .dsh-schedule-panel, .dsh-schedule-reading, .dsh-schedule-form > fieldset { display: grid; align-content: start; gap: 16px; min-width: 0; }
.dsp-memory-detail-heading, .projects-library-heading, .dsh-overview-heading, .dsh-overview-block-heading, .dsh-schedule-header, .dsh-schedule-section-heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
.projects-library-actions, .projects-library-filters, .projects-library-toolbar, .dsh-projects__history-form-actions, .dsh-projects__source-meta, .dsh-overview-meta, .dsh-overview-source-link, .dsh-overview-links, .dsh-schedule-toolbar, .dsh-schedule-item-actions, .dsh-schedule-sources > div, .dsp-memory-item-title, .projects-ui__tool-card-heading-layout, .dsh-projects-communication__routing, .dsh-projects-communication__partHeader, .dsh-projects-communication__factGrid { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.dsp-memory-item-meta, .projects-library-note, .projects-library-count, .projects-library-directory, .projects-library-readingheader small, .projects-library-detailcontent, .projects-library-sources, .dsh-projects__history-result-meta, .dsh-projects__history-result-context, .dsh-projects__source-meta, .dsh-overview-meta, .dsh-overview-note, .dsh-overview-reading, .dsh-usage-note, .dsh-usage-cost, .dsh-usage-legend, .dsh-usage-metrics dt, .dsh-schedule-note, .dsh-schedule-caption, .dsh-schedule-item-session, .dsh-schedule-next-summary, .dsh-schedule-recent, .dsh-schedule-sources, .dsh-schedule-run small { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dsp-memory-detail-heading h3, .projects-library h2:not(:where(.projects-library-document *)), .projects-library-readingheader h2, .projects-library-reading h3:not(:where(.projects-library-document *)), .projects-library-sources h3, .dsh-overview-heading h2, .dsh-overview-block-heading h3, .dsh-schedule-panel h2, .dsh-schedule-panel h3, .dsh-schedule-panel h4 { margin: 0; font: inherit; font-weight: 500; overflow-wrap: anywhere; }
.projects-library p:not(:where(.projects-library-document *)), .projects-library-reader :where(p):not(:where(.projects-library-document *)), .dsh-overview-board p, .dsh-usage-panel p, .dsh-schedule-panel p { margin: 0; overflow-wrap: anywhere; }
.dsp-memory-body, .dsp-memory-source-text, .projects-library-body, .dsh-projects__source-text, .dsh-overview-summary, .dsh-overview-row dd, .dsh-overview-board td, .dsh-schedule-prompt { white-space: pre-wrap; overflow-wrap: anywhere; }
.projects-library-refadd > summary, .projects-library-readingdetails > summary, .dsh-overview-reading > summary, .dsh-usage-details > summary, .dsh-schedule-details > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; min-height: 28px; }

/* Memory keeps one editor owner; the breakpoint changes visibility only. */
.projects-memory-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 16px; }
.dsp-memory-list { display: flex; flex-direction: column; align-self: start; gap: 8px; min-width: 0; max-height: 60dvh; overflow-y: auto; overscroll-behavior: contain; padding-right: 16px; border-right: 0.5px solid var(--dsw-alias-border-l3); }
.dsp-memory-toolbar, .dsh-overview-list, .dsh-usage-heading { display: grid; gap: 8px; }
.dsp-memory-toolbar .dsp-settings-actions, .dsh-schedule-form-actions { justify-content: flex-end; }
.dsp-memory-list-heading { padding: 8px; }
.dsp-memory-filter { display: flex; flex-wrap: wrap; gap: 4px; }
.dsp-memory-list-item.dsp-memory-list-item { justify-content: flex-start; gap: 8px; width: 100%; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dsp-memory-list-item.dsp-memory-list-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsp-memory-list-item.dsp-memory-list-item:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dsp-memory-list-item[aria-current='true'] { background: var(--dsw-specific-sidebar-nav-item-active); color: var(--dsw-alias-label-primary); }
.dsp-memory-list-item.dsp-memory-list-item[aria-current='true'] { background: var(--dsw-specific-sidebar-nav-item-active); border-color: var(--dsw-alias-border-l4); }
.dsp-memory-entry-arrow { width: 16px; height: 16px; flex: none; margin-inline-start: auto; color: var(--dsw-alias-label-secondary); }
.dsp-memory-item-title { width: 100%; flex-wrap: nowrap; }
.dsp-memory-item-title strong, .dsp-memory-list-item > strong, .dsh-schedule-item-heading > strong { font-weight: 500; overflow-wrap: anywhere; }
.dsp-memory-item-summary { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; color: var(--dsw-alias-label-secondary); }
.dsp-memory-item-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin: 0; }
.dsh-projects__project-card[data-archived='true'], .dsp-settings-related, .dsh-projects__reader-footer small, .dsp-deletion-state, .dsp-deletion-stages>li>span, .dsp-deletion-attachment-status>span, .dsp-deletion-retained, .projects-ui__field-status, .dsp-memory-requirements > span { color: var(--dsw-alias-label-secondary); }
.dsp-memory-back, .dsp-memory-resume { display: none; }
.dsp-memory-resume { align-self: flex-start; max-width: 100%; height: auto; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.dsp-memory-edit-form fieldset, .dsh-schedule-form > fieldset { margin: 0; padding: 0; border: 0; }
.dsp-memory-edit-form legend { margin-bottom: 16px; padding: 0; font-weight: 500; }
.projects-memory-row, .dsh-schedule-row { gap: 12px; }
.projects-memory-row, .dsh-schedule-row, .projects-library-add, .dsh-usage-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.projects-memory small { overflow-wrap: anywhere; }
.dsp-memory-sources, .dsp-memory-detail-footer { margin-top: 24px; }
.dsp-memory-sources > h3 { margin: 0 0 8px; font: inherit; font-weight: 500; }
.projects-memory-source, .dsp-memory-detail-footer { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.projects-memory-source { margin: 12px 0; }
.dsp-memory-source-locator { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }

.dsp-memory-evidence { margin-top: 16px; padding: 16px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform); }
.dsp-memory-source-text { max-height: 432px; margin: 16px 0; overflow: auto; font: inherit; }
.dsh-projects__record, .dsh-projects__form, .dsp-deletion-results .dsh-projects__deletion-result, .dsp-memory-source-text { padding: 16px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dsp-memory-evidence .dsp-memory-source-text { min-width: 0; max-width: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; }
@media (max-width: 899px) {
  .projects-memory-layout { grid-template-columns: minmax(0, 1fr); }
  .dsp-memory-list { max-height: none; overflow: visible; overscroll-behavior: auto; padding: 0; border: 0; }
  .projects-memory[data-memory-pane='list'] .dsp-memory-detail, .projects-memory[data-memory-pane='detail'] .dsp-memory-list { display: none; }
  .dsp-memory-back, .dsp-memory-resume { display: inline-flex; }
  .dsp-memory-back { margin-bottom: 12px; }
}
@media (max-width: 699px) { .projects-memory-row { grid-template-columns: minmax(0, 1fr); } }

/* Library and conversation files share geometry while retaining separate readers. */
.projects-library { gap: 16px; padding: 16px; overflow: auto; container-type: inline-size; }
.projects-library-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.projects-library-toolbar, .dsh-overview-meta { justify-content: space-between; }
.projects-library-search, .projects-library-source code { flex: 1 1 160px; min-width: 0; }
.projects-library-count { display: inline-flex; align-items: center; gap: 4px; }
.projects-library-directory small { margin-inline-start: auto; }
.projects-library-directory-name, .projects-library code:not(:where(.projects-library-document *)), .projects-library-reader code:not(:where(.projects-library-document *)) { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.projects-library-document { min-width: 0; }
.projects-library-viewmode { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.projects-library-location-control { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
.projects-library-location-input { flex: 1 1 160px; min-width: 0; }
.projects-library-add { gap: 12px; align-items: end; padding-top: 16px; }
.projects-library-add > .projects-ui__field > span { min-width: 0; width: 100%; max-width: 100%; }

.projects-library-entries { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.projects-library-entries[hidden] { display: none; }
.projects-library-entries > li { display: flex; align-items: center; gap: 4px; min-width: 0; }
.projects-library-entry.projects-ui__list-row { flex: 1; width: auto; min-width: 0; min-height: 48px; gap: 8px; border-radius: 12px; }
.projects-library-entry .projects-ui__list-row-icon { width: 20px; height: 20px; border: 0; border-radius: 0; background: transparent; color: var(--dsw-alias-label-tertiary); }
.projects-library-entry-copy strong, .projects-library-entry-copy small, .projects-library-entry-description { display: block; white-space: normal; overflow-wrap: anywhere; }
.projects-library-chevron { color: var(--dsw-alias-label-tertiary); }
.projects-library-reader { overflow: auto; }
.projects-library-readingheader { flex-direction: column; gap: 12px; padding: 16px; }
.dsh-projects__project-head, .dsh-projects__side-tabs, .projects-library-readingheader { display: flex; flex: none; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.projects-library-back { align-self: flex-start; min-width: 0; max-width: 100%; height: auto; min-height: 28px; padding-block: 4px; white-space: normal; overflow-wrap: anywhere; }
.projects-library-readingbody { box-sizing: content-box; flex: 1; min-width: 0; min-height: 4lh; overflow: auto; padding: 24px; scroll-behavior: auto; overflow-anchor: none; }
.projects-library-readingbody:focus-visible, .projects-library-directory:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.projects-library-body { margin: 0; padding: 0; font: inherit; tab-size: 2; }
.projects-library-readingdetails, .projects-library-sources { margin-top: 24px; }
.projects-library-directory-preview { list-style: none; padding: 0; margin: 0; }
.projects-library-directory-preview li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); overflow-wrap: anywhere; }
.projects-library-download, .projects-library-readreference { display: grid; justify-items: start; gap: 12px; padding: 12px 0 24px; }
.projects-library-readingfooter { flex: none; padding: 12px 16px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.projects-library-readingfooter > .dsh-projects__reader-footer { min-width: 0; max-width: 100%; }
.projects-library-readingfooter button { min-width: 0; max-width: 100%; height: auto; min-height: 28px; padding-block: 4px; white-space: normal; overflow-wrap: anywhere; }
@container (max-width: 320px) { .projects-library-add { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 560px) { .projects-library-readingbody { padding: 16px; } }

/* Saved board blocks retain their order, full content, source facts and tables. */
.dsh-overview-panel { gap: 12px; padding: 16px; overflow: auto; }
.dsh-projects, .projects-library, .projects-library-reader, .dsh-overview-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.dsh-overview-block { display: grid; gap: 12px; min-width: 0; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); }
.projects-ui__settings-row, .dsh-overview-content { gap: 12px; }
.dsh-overview-block-heading { align-items: baseline; }
.dsh-overview-expand { justify-self: start; }
.dsh-overview-block ul { margin: 0; padding-left: 16px; }
.dsh-overview-source, .dsh-schedule-directory, .dsh-schedule-groups, .dsh-schedule-group, .dsh-schedule-history, .dsh-schedule-list, .projects-ui__tool-card-section, .dsh-projects-communication__content, .dsh-projects-communication__body, .dsh-projects-communication__original, .dsh-projects-communication__quoted, .dsh-projects-communication__facts { display: grid; gap: 8px; min-width: 0; }
.dsh-overview-row { display: grid; gap: 8px; min-width: 0; padding: 8px 0; }
.dsh-overview-row dl { display: grid; gap: 8px; margin: 0; }
.dsh-overview-table { overflow: auto; min-width: 0; }
.dsh-overview-board table { width: 100%; min-width: 360px; border-collapse: collapse; font: inherit; }
.dsh-overview-board th, .dsh-overview-board td { min-width: 96px; padding: 8px 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.dsh-overview-board th { font-weight: 500; }
.projects-ui__field > small, .dsp-field > small, .projects-ui__settings-project-name, .projects-ui__settings-footer > span, .projects-memory small, .dsp-memory-source-locator, .projects-library-entry-copy small, .projects-library-entry-description, .dsh-overview-row dt, .dsh-overview-board th, .dsh-usage-scope-heading > span, .dsh-usage-primary-metrics dt, .dsh-usage-table thead th, .dsh-schedule-header p, .dsh-schedule-detail-heading p, .dsh-schedule-weekdays legend, .projects-ui__memory-notice { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-overview-board tbody th { color: var(--dsw-alias-label-primary); }
.dsh-overview-links { align-items: flex-start; }
.dsh-overview-links button { color: var(--dsw-alias-state-business-primary); }

/* Usage uses one reported denominator; SVG attributes carry actual segment widths. */
.dsh-usage-panel { gap: 24px; container-type: inline-size; }
.dsh-usage-heading h2, .dsh-usage-panel h3 { margin: 0; font: inherit; font-weight: 500; }
.dsh-usage-filters { gap: 16px; align-items: end; }
.dsh-usage-filter-actions { display: flex; flex-wrap: wrap; gap: 8px; grid-column: 1 / -1; }
.dsh-usage-scope-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.dsh-usage-primary-metrics, .dsh-usage-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 0; font-variant-numeric: tabular-nums; }
.dsh-usage-primary-metrics dd { margin: 4px 0 0; font-size: 20px; line-height: 28px; font-weight: 500; overflow-wrap: anywhere; }
.dsh-usage-metrics dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.dsh-usage-stack { display: block; width: 100%; height: 8px; overflow: hidden; border-radius: 4px; }
.dsh-usage-stack [data-role='main'], .dsh-usage-legend [data-role='main'] { --usage-color: var(--dsw-alias-state-business-primary); }
.dsh-usage-stack [data-role='execution'], .dsh-usage-legend [data-role='execution'] { --usage-color: var(--dsw-alias-state-business-tertiary); }
.dsh-usage-stack [data-role='memory'], .dsh-usage-legend [data-role='memory'] { --usage-color: var(--dsw-alias-label-secondary); }
.dsh-usage-stack [data-role='session-manager'], .dsh-usage-legend [data-role='session-manager'] { --usage-color: var(--dsw-alias-label-tertiary); }
.dsh-usage-stack rect { fill: var(--usage-color); }
.dsh-usage-legend { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dsh-usage-legend > li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.projects-ui__list-row-end, .dsh-usage-legend-label, .dsh-schedule-check, .projects-ui__loading-inline { display: inline-flex; align-items: center; gap: 8px; }

.dsh-usage-swatch { width: 8px; height: 8px; border-radius: 4px; background: var(--usage-color); }
.dsh-usage-table { max-width: 100%; overflow: auto; }
.dsh-usage-table table { width: 100%; min-width: 680px; border-collapse: collapse; font: inherit; font-variant-numeric: tabular-nums; }
.dsh-usage-table th, .dsh-usage-table td { padding: 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); text-align: right; vertical-align: top; white-space: nowrap; }
.dsh-usage-table thead th { font-weight: 500; }
.dsh-usage-table th:first-child { min-width: 144px; max-width: 240px; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.dsh-usage-details { min-width: 0; }
.dsh-projects__source-item + .dsh-projects__source-item, .dsp-deletion-retained, .dsp-deletion-actions, .dsp-memory-sources, .dsp-memory-detail-footer, .projects-library-refadd, .projects-library-readingdetails, .projects-library-sources, .dsh-schedule-detail-heading, .dsh-schedule-future, .dsh-schedule-removed, .dsh-schedule-form-actions, .dsh-usage-details { padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-usage-details ul { padding-left: 16px; }
@container (max-width: 460px) { .dsh-usage-filters { grid-template-columns: minmax(0, 1fr); } }

/* Schedule rows, receipts and the native 440 editor keep independent boundaries. */
.dsh-schedule-panel { width: 100%; padding: 16px; container-type: inline-size; }
.dsh-schedule-panel :is(h2, h3, h4, p) { overflow-wrap: anywhere; }
.dsh-schedule-header p, .dsh-schedule-detail-heading p { margin-top: 4px; }
.dsh-schedule-availability, .dsh-schedule-notice { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; }
.dsh-schedule-workspace { display: grid; gap: 24px; min-width: 0; }
.dsh-schedule-item-row { padding: 8px; border-radius: 12px; }
.dsh-schedule-item-row[data-selected='true'] { background: var(--dsw-alias-bg-layer-1); }
.dsh-schedule-item.dsh-schedule-item { flex: 1; gap: 4px; padding: 8px; border: .5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.dsp-memory-list-item, .dsh-schedule-item { display: flex; flex-direction: column; align-items: stretch; height: auto; min-width: 0; text-align: left; white-space: normal; }
.dsh-schedule-item-heading { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-schedule-item-chevron { flex: none; margin-inline-start: auto; align-self: center; color: var(--dsw-alias-label-secondary); }
.dsh-schedule-item-actions { flex: none; flex-wrap: nowrap; }
.dsh-schedule-next { padding: 8px 12px; border-radius: 12px; background: var(--dsw-alias-bg-module-platform); }
.dsh-schedule-caption { display: block; }
.dsh-schedule-run { display: grid; gap: 8px; min-width: 0; padding: 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }

.dsh-schedule-run-tag { max-width: 100%; white-space: normal; }
.projects-library-reading, .projects-library-detailcontent, .projects-library-sources, .dsh-usage-summary, .dsh-usage-breakdown, .dsh-usage-scope, .dsh-schedule-future, .dsh-schedule-sources, .dsh-schedule-notice, .dsh-schedule-receipt, .dsh-schedule-form-section, .dsh-schedule-rule { display: grid; gap: 12px; min-width: 0; }
.dsh-schedule-rule { margin-top: 16px; }
.dsh-schedule-weekdays { display: flex; flex-wrap: wrap; gap: 8px 12px; min-width: 0; margin: 0; padding: 8px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; }
.dsh-schedule-weekdays legend { padding: 0 4px; }
.dsh-schedule-overview { padding: 0; gap: 12px; }
@container (max-width: 480px) { .dsh-schedule-row { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 479px) { .dsh-schedule-row { grid-template-columns: minmax(0, 1fr); } }

/* History summaries link to complete source bodies; unlinked text stays complete. */
.dsh-projects__history { container: projects-history / inline-size; }
.dsh-projects__history-form { display: grid; gap: 12px; min-width: 0; padding-bottom: 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-projects__history-searchbar { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
.dsh-projects__history-keyword { flex: 1; min-width: 0; }
.dsh-projects__history-searchbar > button { flex: none; }
.dsh-projects__history-filters, .dsh-projects__history-date-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; min-width: 0; }
.dsh-projects__history-date-filters { min-width: 0; }
.dsh-projects__history-date-filters > summary, .dsh-projects__history-versions > summary, .dsh-projects__history-process > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 20px; }
.dsh-projects__history-date-fields { margin-top: 12px; }
.dsh-projects__history-results-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-projects__history-result-title { display: block; font-weight: 500; overflow-wrap: anywhere; }
.dsh-projects__history-result-row { padding-block: 12px; }
.dsh-projects__history-versions { padding: 4px 12px 10px; min-width: 0; }
.dsh-projects__history-versions > section { margin-top: 8px; }
.dsh-projects__history-context { display: grid; gap: 18px; min-width: 0; }
.dsh-projects__history-context-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dsh-projects__history-context-heading { padding-bottom: 14px; border-bottom: .5px solid var(--dsw-alias-border-l3); }
.dsh-projects__history-context-heading h3 { margin: 0 0 6px; font-size: var(--dsh-content-font-size, 14px); line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.dsh-projects__history-thread { display: grid; gap: 22px; min-width: 0; }
.dsh-projects__history-message { display: grid; gap: 8px; min-width: 0; padding: 4px 0; }
.dsh-projects__history-message--target { padding-inline-start: 12px; border-inline-start: 2px solid var(--dsw-alias-link); }
.dsh-projects__history-message-meta { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dsh-projects__history-message-meta > span:first-child { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-projects__history-target-label { margin-inline-start: auto; color: var(--dsw-alias-link); }
.dsh-projects__history-chat-text { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--dsh-content-font-size, 14px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)); }
.dsh-projects__history-chat-text .markdown { white-space: normal; }
.dsh-projects__history-message--user > .dsh-projects__history-chat-text { padding: 12px 14px; background: var(--dsw-alias-interactive-bg-hover); border-radius: 10px; }
.dsh-projects__history-process { min-width: 0; border-top: .5px solid var(--dsw-alias-border-l3); padding-top: 12px; }
.dsh-projects__history-process article { min-width: 0; margin-top: 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; }
.dsh-projects__history-process pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-projects__history mark { color: inherit; background: var(--dsw-alias-interactive-bg-hover); text-decoration: underline; text-underline-offset: 2px; }
.dsh-projects__history-form > .dsp-field > span { min-width: 0; max-width: 100%; }
@container projects-history (max-width: 575px) { .dsh-projects__history-form { grid-template-columns: minmax(0, 1fr); } }
@container projects-history (max-width: 400px) { .dsh-projects__history-date-fields { grid-template-columns: minmax(0, 1fr); } }
.dsh-projects__history-result-speaker { font-weight: 500; }
.dsh-projects__history-result-summary { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; margin-top: 6px; }
.dsh-projects__history-result-summary--unlinked { display: block; -webkit-line-clamp: unset; overflow: visible; }
.dsh-projects__history-result-row--unlinked { display: grid; gap: 4px; min-width: 0; padding: 8px; }
.dsh-projects__source-text { margin: 12px 0; }
.projects-ui__textarea, .projects-ui__empty, .projects-ui__error, .projects-ui__state-title, .projects-ui__settings-nav-item, .dsp-memory-item-title strong, .dsp-memory-list-item > strong, .dsh-schedule-item-heading > strong, .dsh-projects__history-result-summary, .dsh-projects__source-text { font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); }
.dsh-schedule-item-row, .dsh-projects__session-row-shell { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; min-width: 0; }

.dsh-projects__readonly > p { margin: 8px 0 0; }
.dsh-projects__deletion-summary { overflow-wrap: anywhere; }
.dsh-schedule-manager-modal { width: 800px; max-width: 100%; max-height: 100%; }
.dsh-schedule-manager-content .dsh-schedule-panel { box-sizing: border-box; }
@media (max-width: 699px) { .dsh-projects__history-form { grid-template-columns: minmax(0, 1fr); } }

/* The same thin card is installed for panel and independent tool-view consumers. */
.projects-ui__tool-card { margin: 4px 0 4px 4px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-markdown-code-block); }
.projects-ui__tool-card-header { height: auto; min-height: 28px; gap: 8px; padding: 4px 12px; overflow: visible; }
.projects-ui__tool-card-leading { width: 28px; height: 28px; margin-right: 0; }
.projects-ui__tool-card .projects-ui__tool-card-leading svg:not([data-state]) { width: 16px; height: 16px; }
.projects-ui__tool-card-title { flex: 0 1 auto; min-width: 0; color: var(--dsw-alias-label-secondary); font-weight: 500; overflow-wrap: anywhere; }
.projects-ui__field, .dsp-field, .projects-ui__state-description, .dsp-memory-item-summary, .dsp-memory-requirements > span, .dsh-usage-table table, .dsh-projects__history-result-speaker, .dsh-projects__deletion-summary, .projects-ui__tool-card, .projects-ui__tool-card-title { font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
.projects-ui__tool-card-status, .dsh-project-feedback__status, .dsh-projects-communication__hint, .dsh-projects-communication__identity { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.projects-ui__tool-card-body { display: grid; gap: 12px; min-width: 0; max-height: 260px; padding: 12px 16px; overflow: auto; }
.projects-ui__tool-card-persistent, .projects-ui__tool-card-actions { display: grid; gap: 8px; min-width: 0; padding: 8px 16px; }
.projects-ui__tool-card-persistent:empty, .projects-ui__tool-card-actions:empty { display: none; }
.dsh-projects__conversation-heading, .dsh-projects__session-actions, .dsp-settings-actions, .dsp-settings-related, .dsh-projects__reading-context, .dsh-projects__source-location, .projects-ui__settings-footer, .projects-library-readingfooter, .dsh-schedule-run > header, .dsh-projects__workspace-picker, .dsh-projects__reader-footer, .projects-library-source, .dsh-projects__history-result-meta, .projects-ui__tool-card-actions, .dsh-projects-tool-card__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.projects-ui__tool-card-exception { display: grid; gap: 4px; color: var(--dsw-alias-state-warn-primary); }
.projects-ui__tool-card-section, .projects-ui__tool-card-payload, .projects-ui__tool-card-raw { min-width: 0; max-height: none; overflow: visible; }
.dsh-projects-tool-card__body:not(.projects-ui__tool-card-raw) { min-width: 0; max-height: 240px; overflow: auto; }
.projects-ui__tool-card-section-label, .dsh-projects-communication__content h4 { font: inherit; font-weight: 500; }
.dsh-projects__hint, .dsh-projects__lifecycle-report ul, .dsh-projects__session-subtitle, .dsh-projects__history-meta, .dsp-settings-locations dt, .projects-ui__tool-card-section-label, .dsh-projects-communication__content h4 { margin: 0; color: var(--dsw-alias-label-secondary); }
.projects-ui__tool-card-raw, .dsh-projects-communication__text { margin: 0; font-family: var(--ds-font-family-code); font-size: inherit; line-height: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-projects__project-state, .dsp-deletion-project[data-state='partial']>.dsp-deletion-project-status, .projects-ui__field-error, .projects-ui__danger-action, .projects-ui__error .projects-ui__state-icon, .dsh-schedule-run[data-status='execution-failed'] .dsh-schedule-note, .dsh-schedule-run[data-status='delivery-failed'] .dsh-schedule-note, .dsh-schedule-recent[data-status='execution-failed'], .dsh-schedule-recent[data-status='delivery-failed'], .dsh-project-feedback__error, .dsh-projects-tool-card__error, .dsh-projects-tool-card__body--error, .dsh-projects-communication__quoted[data-error='true'] > strong { color: var(--dsw-alias-state-error-primary); }
.dsh-projects-communication__link { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; max-width: 100%; }
.dsh-projects-communication__part { display: grid; gap: 8px; min-width: 0; padding-left: 12px; border-left: 0.5px solid var(--dsw-alias-border-l3); }
.dsh-projects-communication__factGrid > p { flex: 1 1 208px; min-width: 0; }
.dsh-projects-communication__attachment { display: grid; justify-items: start; gap: 4px; min-width: 0; }
.dsh-projects-communication__imageLink { display: block; width: fit-content; max-width: 100%; }
.dsh-projects-communication__image { display: block; max-width: 100%; max-height: 360px; object-fit: contain; }
.dsh-projects__lifecycle-report, .dsp-deletion-member, .dsh-projects-communication__quoted { padding: 12px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); }
.projects-ui__memory-notice { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 0; overflow-wrap: anywhere; }
.projects-ui__memory-notice > svg { flex: none; width: 16px; height: 16px; }
.projects-ui__empty, .projects-ui__error { box-sizing: border-box; min-height: 208px; }
.projects-ui__loading-inline { min-height: 28px; width: auto; padding: 0; }
.projects-ui__loading-list { box-sizing: border-box; display: grid; align-content: start; gap: 12px; min-height: 208px; }
.projects-ui__loading-label { display: inline-flex; align-items: center; gap: 8px; }
.dsh-projects-communication__link > button, .dsh-projects-communication__attachment > button { height: auto; min-height: 28px; max-width: 100%; white-space: normal; overflow-wrap: anywhere; padding-block: 4px; text-align: start; }
.projects-ui__tool-card-section { grid-template-columns: minmax(0, 1fr); }
.dsh-usage-details li { overflow-wrap: anywhere; }
.projects-ui__diagnostic { white-space: pre-wrap; overflow-wrap: anywhere; }
.projects-ui__skeleton-row { display: grid; align-content: center; gap: 8px; min-height: 36px; }
.projects-ui__skeleton-short { width: 55%; }
.projects-ui__main-welcome { text-align: center; font-family: var(--dsw-font-family); }
.projects-ui__main-welcome-page-title { margin: 0; max-width: 100%; font: inherit; overflow-wrap: anywhere; }
.projects-ui__main-welcome-description { margin: 0; color: var(--dsw-alias-label-secondary); font-size: var(--dsh-content-font-size, 14px); line-height: calc(22px + var(--dsh-content-font-delta, 0px)); overflow-wrap: anywhere; }
.projects-ui__visually-hidden { padding: 0; border: 0; white-space: nowrap; }
.projects-ui__native-field, .dsh-schedule-form-legend, .projects-ui__visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
/* Semantic anchors follow the host Markdown link palette and focus treatment. */
.projects-ui__source-link { color: var(--dsw-alias-link); font-weight: 500; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.projects-ui__source-link:hover, .projects-ui__source-link:focus { outline: none; text-decoration: underline dotted var(--dsw-alias-link); text-underline-offset: 3px; }
.projects-ui__source-link:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.projects-ui__notice-details > summary:focus-visible, .projects-ui__notice-content:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; border-radius: 4px; }
.projects-ui__domain-notices .projects-ui__field-error { font-size: inherit; line-height: inherit; }
.projects-ui__notice-details > summary { min-height: 28px; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.projects-ui__notice-content { min-width: 0; max-height: 240px; overflow: auto; overscroll-behavior: contain; color: var(--dsw-alias-label-primary); }
.projects-ui__notice-content dl { display: grid; gap: 12px; margin: 12px 0 0; }
.projects-ui__notice-content dt { font-weight: 500; }
.projects-ui__notice-content dd { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
/* Consequences, errors and read boundaries follow the user's secondary content size. */
.projects-ui__field-error, .projects-ui__state-description, .projects-ui__stock-readonly, .projects-ui__tool-card-exception, .dsp-deletion-note, .dsp-deletion-error, .projects-library-note, .dsh-projects__history-meta, .dsh-projects__readonly, .dsh-overview-note, .dsh-overview-source-notices, .dsh-usage-note, .dsh-usage-cost, .dsh-usage-scope, .dsh-schedule-note, .dsh-schedule-notice, .dsh-schedule-receipt, .dsh-projects-communication__hint, .dsh-project-feedback__error { font-size: var(--projects-key-text-size); line-height: var(--projects-key-text-leading); }
.dsh-usage-row-label { display: grid; gap: 4px; }
.dsh-usage-row-status { color: var(--dsw-alias-label-secondary); font-size: var(--projects-key-text-size); line-height: var(--projects-key-text-leading); white-space: normal; overflow-wrap: anywhere; }
`;

/** Host-aligned general layout values; host components own their internal metrics. */
export const SPACE = { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const RADIUS = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, dialog: 28 } as const;
export const FONT_SIZE = {
  title: "20px",
  body: "var(--dsh-content-font-size, 14px)",
  secondary: "var(--dsh-content-font-size-secondary, 13px)",
  metadata: "12px",
  label: "11px",
} as const;
export const LINE_HEIGHT = { title: 28, body: 22, secondary: 20, metadata: 18, label: 14 } as const;
export const BORDER_WIDTH = 0.5;
