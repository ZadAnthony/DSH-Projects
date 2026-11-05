import { projectCopy, type ProjectsTranslate } from './ui/copy.ts'
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ConnectionHandle, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client';
import { Button, ErrorState, LoadingState, Select } from './ui/index.ts';
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client';

type Directory = Pick<ModelDirectory, 'store' | 'load' | 'select'>;
export interface ProjectMainModelControlInjected {
  readonly acquireDirectory: () => { readonly ready: Promise<Directory>; release(): void };
  readonly generation: ConnectionHandle['generation'];
  readonly translate?: ProjectsTranslate;
  readonly t?: ProjectsTranslate;
}

/** 设置可编辑与聊天只读各用原生reference；只在设置出现时借用配置目录。 */
export function ProjectMainModelControl({ acquireDirectory, generation , translate, t}: ProjectMainModelControlInjected) {
  const copy = projectCopy(translate ?? t)
  const currentGeneration = useSyncExternalStore(
    listener => generation.subscribe(listener),
    () => generation.getSnapshot(),
  );
  const [opened, setOpened] = useState<{ generation: unknown; directory?: Directory; error?: string }>();
  useEffect(() => {
    if (currentGeneration === undefined) return;
    let active = true;
    let lease: ReturnType<ProjectMainModelControlInjected['acquireDirectory']>;
    try { lease = acquireDirectory(); }
    catch (error: unknown) {
      setOpened({ generation: currentGeneration, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    void lease.ready.then(directory => {
      if (active) setOpened({ generation: currentGeneration, directory });
    }).catch((error: unknown) => {
      if (active) setOpened({ generation: currentGeneration, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; lease.release(); };
  }, [acquireDirectory, currentGeneration]);
  if (currentGeneration === undefined) return <ErrorState inline title={copy("p5.model.disconnected")} />;
  if (opened?.generation !== currentGeneration) return <LoadingState label={copy("p5.model.loadingMainSettings")} rows={1} />;
  if (opened.error !== undefined) return <ErrorState inline title={copy('p5.model.mainSettingsUnreadable')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: opened.error }} />;
  if (opened.directory === undefined) return null;
  return <ProjectModelDirectoryControl copy={copy} directory={opened.directory} generation={generation} />;
}

/** 只呈现当前主会话的原生目录；保存、默认值和并发结果仍由同一目录处理。 */
function ProjectModelDirectoryControl({ directory, generation , copy}: { directory: Directory; generation: ConnectionHandle['generation'] ; readonly copy: ProjectsTranslate }) {
  const state = useSyncExternalStore(
    listener => directory.store.subscribe(listener),
    () => directory.store.getSnapshot(),
  );
  const connected = useSyncExternalStore(
    listener => generation.subscribe(listener),
    () => generation.getSnapshot() !== undefined,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const showError = (error: unknown) => setActionError(error instanceof Error ? error.message : String(error));
  const load = () => {
    setActionError(null);
    void directory.load().catch(showError);
  };
  useEffect(() => {
    if (!connected) return;
    void directory.load().catch(showError);
  }, [directory, connected]);

  const choices = state.groups.flatMap(group => group.models.map(model => ({ group, model,
    key: JSON.stringify([group.id, model.id]),
  })));
  const selected = choices.find(choice => choice.group.id === state.current?.provider && choice.model.id === state.current.model);
  const currentKey = state.current === null ? '' : JSON.stringify([state.current.provider, state.current.model]);
  const reasoning = selected?.model.reasoning;
  const effort = state.current?.reasoningEffort;
  const missingEffort = effort !== undefined && reasoning?.efforts.some(choice => choice.id === effort) !== true;
  const pending = state.pending !== null || state.status === 'selecting';
  const disabled = !connected || pending || state.status === 'loading';
  const select = (selection: ModelSelection) => {
    setActionError(null);
    void directory.select(selection).catch(showError);
  };

  return <div className="dsh-projects__main-model dsp-settings-model-grid" aria-busy={pending || state.status === 'loading'}>
    <label className="dsp-field">{copy("p5.model.mainModel")}<Select aria-label={copy("p5.model.mainModel")} value={currentKey} disabled={disabled || choices.length === 0}
        onValueChange={value => {
          const choice = choices.find(item => item.key === value);
          if (choice !== undefined) select({ provider: choice.group.id, model: choice.model.id });
        }}>
        {state.current === null && <option value="" disabled>{copy("p5.model.settingsNotLoaded")}</option>}
        {state.current !== null && selected === undefined && <option value={currentKey} disabled>
          {state.current.provider}/{state.current.model}{copy("p5.common.currentlyUnavailable")}</option>}
        {state.groups.map(group => <optgroup key={group.id} label={group.name}>
          {group.models.map(model => <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name}</option>)}
        </optgroup>)}
      </Select>
    </label>
    {reasoning !== undefined && <label className="dsp-field">{copy("p5.model.reasoningEffort")}<Select aria-label={copy("p5.model.mainReasoningEffort")} value={effort ?? ''} disabled={disabled || state.current === null}
        onValueChange={value => {
          if (state.current === null) return;
          if (value !== '' && !reasoning.efforts.some(choice => choice.id === value)) return;
          select({ provider: state.current.provider, model: state.current.model,
            ...(value === '' ? {} : { reasoningEffort: value }) });
        }}>
        <option value="">{copy("p5.model.providerDefault")}{reasoning.defaultEffort === undefined ? '' : copy("p5.common.punctuationTemplate1", { value: reasoning.efforts.find(choice => choice.id === reasoning.defaultEffort)?.name ?? reasoning.defaultEffort })}</option>
        {missingEffort && <option value={effort} disabled>{state.retainedEffort ?? effort}{copy("p5.common.currentlyUnavailable")}</option>}
        {reasoning.efforts.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
      </Select>
    </label>}
    {reasoning === undefined && state.retainedEffort !== undefined && <p>{copy("p5.model.reasoningEffortPrefix")}{state.retainedEffort}</p>}
    {!connected && <ErrorState inline title={copy("p5.model.disconnected")} />}
    {state.status === 'loading' && <LoadingState label={copy("p5.model.loadingDirectory")} rows={1} />}
    {pending && <LoadingState label={copy("p5.model.savingSettings")} rows={1} />}
    {state.routable === false && <ErrorState inline title={copy("p5.model.savedModelUnavailable")} />}
    {state.failures.map(failure => <ErrorState inline key={failure.id} title={failure.name} description={copy('p5.settings.execution.catalogUnavailable')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: failure.message }} />)}
    {(actionError ?? state.error) !== null && <ErrorState inline title={copy('p5.model.settingsOperationFailed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: actionError ?? state.error ?? '' }} />}
    {(actionError ?? state.error) !== null && <Button variant="outline" size="md" type="button" disabled={!connected || pending || state.status === 'loading'} onClick={load}>{copy("p5.model.retrySettings")}</Button>}
  </div>;
}
