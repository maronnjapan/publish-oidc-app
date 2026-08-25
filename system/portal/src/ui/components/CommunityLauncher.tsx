import { COMMUNITY, blogLinks } from "../../shared/community";
import { LinkList } from "./Hints";

/**
 * The floating "where do I ask?" button, bottom right of every screen.
 *
 * It is a `<details>` rather than a button with a click handler: the panel then opens
 * before the client bundle has run and while a creation is in flight — the two moments
 * someone is most likely to want it — and its open state lives in the DOM, so hydration has
 * nothing to disagree about. It sits outside the form's fieldset for the same reason.
 * Everything it says comes from `community.json`.
 */
export function CommunityLauncher() {
  const { heading, consult, blog } = COMMUNITY;
  return (
    <details class="community">
      <summary class="community-toggle" title={heading} aria-label={heading}>
        {/* Presentation attributes rather than a `style` prop: `style-src 'self'` blocks
            the style attribute those become. */}
        <svg class="community-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H8.2L3.5 21.5l1.3-3.9A7.5 7.5 0 1 1 20 11.5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linejoin="round"
          />
          <circle cx="8.6" cy="11.5" r="1.05" fill="currentColor" />
          <circle cx="12" cy="11.5" r="1.05" fill="currentColor" />
          <circle cx="15.4" cy="11.5" r="1.05" fill="currentColor" />
        </svg>
      </summary>
      <div class="community-panel">
        <h2>{heading}</h2>
        <p>
          {consult.summary}
          <LinkList links={[consult.link]} />
        </p>
        <p>
          {blog.summary}
          <LinkList links={blogLinks()} />
        </p>
      </div>
    </details>
  );
}
