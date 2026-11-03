import type { Translate } from "@deepseek-ai/dsh-client-ui-slots";
import { en, zh, type ProjectsKey } from "../locales.ts";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap { projects: ProjectsKey; }
}

export type ProjectsTranslate = Translate<ProjectsKey>;

interface ProjectsLocaleRegistry {
  register(namespace: "projects", dictionaries: { readonly en: typeof en; readonly zh: typeof zh }): () => void;
}
type ProjectsLocaleOwner = { readonly release: () => void; references: number };
const localeOwners = new WeakMap<ProjectsLocaleRegistry, ProjectsLocaleOwner>();

/** One dictionary owner per actual registry; Reader and its tool cards share it. */
export function acquireProjectsLocale(locale: ProjectsLocaleRegistry): () => void {
  let owner = localeOwners.get(locale);
  if (owner === undefined) {
    owner = { release: locale.register("projects", { en, zh }), references: 0 };
    localeOwners.set(locale, owner);
  }
  owner.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owner.references !== 0) return;
    // Native release publishes a revision; a subscriber can acquire a new owner.
    localeOwners.delete(locale);
    owner.release();
  };
}

const defaultProjectCopy: ProjectsTranslate = (key, params) => {
  const template = zh[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
};

const englishProjectCopy: ProjectsTranslate = (key, params) => {
  const template = en[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
};

/** Host locale publishes html.lang before its surface rerender; standalone leaves retain Chinese. */
export function projectDocumentCopy(document?: Document): ProjectsTranslate {
  const language = document?.documentElement.lang ?? "";
  return language === "" || /^zh(?:-|$)/i.test(language) ? defaultProjectCopy : englishProjectCopy;
}

/** Use the caller's locale service, or the existing Chinese dictionary for standalone leaves. */
export function projectCopy(translate?: ProjectsTranslate): ProjectsTranslate {
  return translate ?? defaultProjectCopy;
}

/** Keep the caller's locale service, keys, parameters and result unchanged. */
export function t(translate: ProjectsTranslate, ...args: Parameters<ProjectsTranslate>): string {
  return translate(...args);
}
