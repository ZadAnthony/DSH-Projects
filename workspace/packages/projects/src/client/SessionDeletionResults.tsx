import React, { type ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, ErrorState, Tag } from "./ui/index.ts";
import type { ProjectRecord, ProjectSessionDeletionResult } from "../public-types.ts";

type Translate = PropsLocale<"projects">["t"];

/** 结果区只继续清理，不提供打开或恢复已失效聊天的入口。 */
export function SessionDeletionResults({ results, t, busy = false, onContinue }: {
  readonly results: readonly ProjectSessionDeletionResult[];
  readonly t: Translate;
  readonly busy?: boolean;
  readonly onContinue?: (result: ProjectSessionDeletionResult) => void;
}): ReactNode {
  if (results.length === 0) return null;
  const stages = [
    ["projectionCache", "projection-cache"], ["sessionLog", "session-log"],
    ["queryIndex", "query-index"], ["sessionInstructions", "session-instructions"],
  ] as const;
  const scheduleStages = [["projectSchedules", "project-schedules"], ["nativeSchedules", "native-schedules"]] as const;
  return <section className="dsh-projects__deletion-results dsp-deletion-results" aria-label={t("sessions.deletion.title")}>
    <h3>{t("sessions.deletion.title")}</h3>
    {results.map(result => {
      const lifecycle = result.sourceLifecycle;
      return <article key={`${result.id}:${result.hostSessionId ?? ''}`} className="dsh-projects__deletion-result" data-state={lifecycle.kind}>
        <header className="dsp-deletion-heading"><h4>{result.title}</h4><p className="dsp-deletion-state" role="status"><Tag tone={lifecycle.kind === "partial" ? "warning" : "info"}>{t(`sessions.deletion.${lifecycle.kind}`)}</Tag></p></header>
        {result.hostSessionId !== undefined && <p className="dsp-deletion-identity"><code>{result.hostSessionId}</code></p>}
        {result.lifecycleTimeBasis === 'project-deletion' && <p className="dsp-deletion-note">{t("p5.panel.legacyDeletionTimestamp")}</p>}
        <ul className="dsp-deletion-stages">{[...stages, ...scheduleStages].map(([key, stage]) => <li key={key}>
          <span>{t(`sessions.deletion.stage.${stage}`)}</span><strong>{lifecycle.progress[key] === undefined
            ? t("sessions.deletion.unconfirmed") : t(`sessions.deletion.progress.${lifecycle.progress[key]}`)}</strong>
        </li>)}</ul>
        {lifecycle.fileDeletion !== undefined && <p className="dsp-deletion-attachment-status">
          <span>{t("sessions.deletion.stage.file-attachments")}</span><strong>{lifecycle.fileDeletion.complete
            ? t("sessions.deletion.progress.file-completed") : t("sessions.deletion.unconfirmed")}</strong>
        </p>}
        {lifecycle.imageDeletion !== undefined && <details className="dsp-deletion-details" open>
          <summary><span>{t("sessions.deletion.stage.image-attachments")}</span><strong>{lifecycle.imageDeletion.complete
            ? t("sessions.deletion.progress.image-completed") : t("sessions.deletion.unconfirmed")}</strong></summary>
          <ul>{lifecycle.imageDeletion.results.map(item => <li key={`${item.kind}:${item.ref.attachmentId}:${item.kind === "image-object" ? "" : item.variantId}`}>
            {item.ref.name === undefined ? "" : `${item.ref.name} · `}{t(`sessions.deletion.image-kind.${item.kind}`)}{t("p5.common.colon")}{t(`sessions.deletion.image-outcome.${item.outcome}`)}
            {item.message === undefined ? null : t("p5.common.punctuationTemplate1", { value: item.message })}
          </li>)}</ul>
        </details>}
        {lifecycle.ownedDeletion !== undefined && lifecycle.ownedDeletion.members.length > 0 && <details className="dsp-deletion-details" open>
          <summary>{t("sessions.deletion.owned.title")}</summary>
          {lifecycle.ownedDeletion.members.map(member => <div className="dsp-deletion-member" key={member.header.id}>
            <h5>{t("sessions.deletion.owned.member", { value: member.header.id })}</h5>
            <ul className="dsp-deletion-stages">{stages.map(([key, stage]) => <li key={key}>
              <span>{t(`sessions.deletion.stage.${stage}`)}</span><strong>{member.progress[key] === undefined
                ? t("sessions.deletion.unconfirmed") : t(`sessions.deletion.progress.${member.progress[key]}`)}</strong>
            </li>)}</ul>
            <p className="dsp-deletion-attachment-status"><span>{t("sessions.deletion.stage.native-schedules")}</span><strong>{member.progress.nativeSchedules === undefined
              ? t("sessions.deletion.unconfirmed") : t(`sessions.deletion.progress.${member.progress.nativeSchedules}`)}</strong></p>
            {member.failure !== undefined && <ErrorState className="dsp-deletion-error" title={t("p5.common.punctuationTemplate2", { value: t(`sessions.deletion.stage.${member.failure.stage}`), value1: member.failure.message })} inline>
              <p>{t(`sessions.deletion.certainty.${member.failure.certainty}`)}</p>
            </ErrorState>}
          </div>)}
        </details>}
        {lifecycle.kind === "partial" && <ErrorState className="dsp-deletion-error" title={t("p5.common.punctuationTemplate2", { value: t(`sessions.deletion.stage.${lifecycle.failure.stage}`), value1: lifecycle.failure.message })} inline>
          <p>{t(`sessions.deletion.certainty.${lifecycle.failure.certainty}`)}</p>
          {lifecycle.failure.knownRemovedArtifacts !== undefined && <p>{t("sessions.deletion.knownRemoved", { value: String(lifecycle.failure.knownRemovedArtifacts) })}</p>}
          {lifecycle.failure.knownRemainingArtifacts !== undefined && <p>{t("sessions.deletion.knownRemaining", { value: String(lifecycle.failure.knownRemainingArtifacts) })}</p>}
        </ErrorState>}
        {onContinue !== undefined && <Button className="projects-ui__danger-action" variant="outline" size="sm" type="button" disabled={busy}
          onClick={() => onContinue(result)}>{t("sessions.deletion.continue")}</Button>}
      </article>;
    })}
  </section>;
}

export type DeletionTarget = {
  readonly projectId: string;
  readonly name: string;
  readonly expectedRevision: number;
} & ({ readonly kind: "project" } | { readonly kind: "execution"; readonly sessionId: string });

export function DeletionConfirmation({ target, t, onConfirm, onCancel }: {
  readonly target: DeletionTarget;
  readonly t: Translate;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  return <section className="dsh-projects__deletion-confirmation dsp-deletion-confirmation">
    <ErrorState className="dsp-deletion-warning" title={t("deletion.confirm.irreversible")} inline />
    <div className="dsp-deletion-scope"><p>{t(target.kind === "project" ? "deletion.confirm.projectScope" : "deletion.confirm.executionScope")}</p>
    <p className="dsp-deletion-retained">{t(target.kind === "project" ? "deletion.confirm.projectRetained" : "deletion.confirm.executionRetained")}</p></div>
    <p className="dsp-deletion-note">{t("deletion.confirm.failure")}</p>
    <div className="dsp-deletion-actions"><Button variant="outline" size="sm" type="button" data-modal-autofocus onClick={onCancel}>{t("deletion.cancel")}</Button>
    <Button className="projects-ui__danger-action" variant="outline" size="sm" type="button" onClick={onConfirm}>{t("deletion.confirm.submit")}</Button></div>
  </section>;
}

export function ProjectDeletionResult({ project, results, t, busy, onContinue }: {
  readonly project: ProjectRecord;
  readonly results: readonly ProjectSessionDeletionResult[];
  readonly t: Translate;
  readonly busy: boolean;
  readonly onContinue: () => void;
}): ReactNode {
  const lifecycle = project.sourceLifecycle;
  const current = lifecycle?.kind === "deleted" ? undefined : lifecycle;
  return <section className="dsh-projects__deletion-results dsp-deletion-results dsp-deletion-project" data-state={lifecycle?.kind ?? 'deleting'} aria-label={t("project.deletion.title")}>
    <h2>{t("project.deletion.title")}</h2>
    <p className="dsp-deletion-project-status" role="status">{lifecycle === undefined ? t("deletion.processing")
      : t(`project.deletion.${lifecycle.kind}`)}</p>
    <p className="dsp-deletion-note">{t("project.deletion.readonly")}</p>
    {lifecycle?.kind !== "deleted" && <p className="dsp-deletion-attachment-status"><span>{t("project.deletion.files")}</span><strong>{current?.progress.projectFiles === undefined
      ? t("sessions.deletion.unconfirmed") : t(`sessions.deletion.progress.${current.progress.projectFiles}`)}</strong></p>}
    {current?.failure !== undefined && <ErrorState className="dsp-deletion-error" title={current.failure.message} inline>
      <p>{t(`sessions.deletion.certainty.${current.failure.certainty}`)}</p>
    </ErrorState>}
    <SessionDeletionResults results={results} t={t} />
    {lifecycle !== undefined && lifecycle.kind !== "deleted" && <Button className="projects-ui__danger-action" variant="outline" size="sm" type="button" disabled={busy}
      onClick={onContinue}>{t("project.deletion.continue")}</Button>}
  </section>;
}

