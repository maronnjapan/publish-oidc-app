import { COMMUNITY, blogLinks } from "../../shared/community";
import { LinkList } from "./Hints";

/**
 * The last thing on the page: where to ask, and where to read.
 *
 * It sits outside the form's fieldset, so it is readable and clickable before hydration and
 * while a creation is running — which is exactly when someone is most likely to want it.
 * Everything it says comes from `community.json`.
 */
export function CommunityFooter() {
  const { heading, consult, blog } = COMMUNITY;
  return (
    <footer class="card community">
      <h2>{heading}</h2>
      <p>
        {consult.summary}
        <LinkList links={[consult.link]} />
      </p>
      <p>
        {blog.summary}
        <LinkList links={blogLinks()} />
      </p>
    </footer>
  );
}
