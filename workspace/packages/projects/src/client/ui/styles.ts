import { projectsUiStyles } from './tokens.css.ts';

type StyleOwner = { node: HTMLStyleElement; references: number };

const documentOwners = new WeakMap<Document, StyleOwner>();

/** Acquire the shared sheet for one UI owner; release it when that owner stops. */
export function acquireUiStyles(document: Document = window.document): () => void {
  let owner = documentOwners.get(document);
  if (!owner) {
    const node = document.createElement('style');
    node.setAttribute('data-dsh-projects-ui', '');
    node.textContent = projectsUiStyles;
    (document.head ?? document.documentElement).appendChild(node);
    owner = { node, references: 0 };
    documentOwners.set(document, owner);
  }
  owner.references += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    owner.references -= 1;
    if (owner.references === 0) {
      owner.node.remove();
      documentOwners.delete(document);
    }
  };
}
