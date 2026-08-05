import type { ComponentChildren } from "preact";
import { type ChoiceLink, resolvedLinks } from "../../shared/catalog";

/**
 * The small pieces every catalog-driven row is built from: its one-line summary, its
 * optional references, and the inline error a field shows once a submit has been attempted.
 */

/** References are optional everywhere, so this renders nothing far more often than not. */
/**
 * The leading space is part of this, not of the caller: it separates the summary from the
 * references inside one paragraph, and a `links` array whose every entry failed to resolve
 * has to render nothing at all — space included.
 */
export function LinkList({ links }: { links?: ChoiceLink[] }) {
  const entries = resolvedLinks(links);
  if (entries.length === 0) return null;
  return (
    <>
      {" "}
      <span class="links">
        {entries.map((entry, index) => (
          <>
            {index > 0 ? "・" : null}
            <a href={entry.href} target="_blank" rel="noopener noreferrer">
              {entry.link.label}
            </a>
          </>
        ))}
      </span>
    </>
  );
}

export function Hint({ children, links }: { children?: ComponentChildren; links?: ChoiceLink[] }) {
  return (
    <p class="hint">
      {children}
      <LinkList links={links} />
    </p>
  );
}

export function FieldError({ message, show }: { message: string; show: boolean }) {
  if (!show || !message) return null;
  return (
    <p class="field-error" role="alert">
      {message}
    </p>
  );
}
