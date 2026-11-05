/** Projects-owned introduction above the resident native main-conversation input. */
import { createContext, useContext, useId } from 'react'
import { IconProjectAddOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import hero from './compat/input/client/skeleton/HeroShell.module.css'

export const ProjectMainWelcomeContext = createContext<{ readonly projectName: string; readonly description: string } | undefined>(undefined)

export function ProjectMainWelcome() {
  const welcome = useContext(ProjectMainWelcomeContext)
  const id = useId()
  if (welcome === undefined) return null
  return <section className={`${hero.root} projects-ui__main-welcome`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
    <div className={hero.stack}>
      <div className={hero.headline}>
        <span className={hero.fishHitbox} aria-hidden="true"><IconProjectAddOutlineRegular className={hero.fish} size={34} /></span>
        <h2 id={`${id}-title`} className={`${hero.titleGroup} projects-ui__main-welcome-page-title`}>{welcome.projectName}</h2>
      </div>
      <p id={`${id}-description`} className="projects-ui__main-welcome-description">{welcome.description}</p>
    </div>
  </section>
}
