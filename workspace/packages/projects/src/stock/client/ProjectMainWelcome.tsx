/** Projects-owned introduction above the resident native main-conversation input. */
import { createContext, useContext, useId } from 'react'
import { IconProjectAddOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

export const ProjectMainWelcomeContext = createContext<{ readonly projectName: string } | undefined>(undefined)

export function ProjectMainWelcome({ t }: PropsLocale<'projects'>) {
  const welcome = useContext(ProjectMainWelcomeContext)
  const id = useId()
  if (welcome === undefined) return null
  return <section className="projects-ui__main-welcome" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
    <span className="projects-ui__main-welcome-icon" aria-hidden="true"><IconProjectAddOutlineRegular size={32} /></span>
    <h2 id={`${id}-title`} className="projects-ui__main-welcome-page-title">{welcome.projectName}</h2>
    <p id={`${id}-description`} className="projects-ui__main-welcome-description">{t('p5.mainWelcome.description')}</p>
  </section>
}
