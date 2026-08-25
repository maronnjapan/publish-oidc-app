import communityCatalog from "../../../../community.json";
import type { ChoiceLink } from "./catalog";

/**
 * Where to ask, and where to suggest.
 *
 * The portal is handed out to people who are trying OpenID Connect, and the two things they
 * most often need next are somewhere to ask and something to read. Both live in
 * `community.json` for the same reason the form's summaries live in their catalogs: the
 * wording and the URLs are content, so changing them is a data edit and the components stay
 * as they are. It is imported by both bundles, so the server render and the hydrating client
 * draw the same panel.
 */

/** One line of prose plus the link it points at. */
export interface CommunityEntry {
  summary: string;
  link: ChoiceLink;
}

/**
 * The blog entry also links back to the consultation channel, because asking for a topic
 * happens there rather than on the blog. Only the label is its own: the href comes from
 * `consult.link`, so the channel's URL is written once.
 */
export interface CommunityBlog extends CommunityEntry {
  requestLinkLabel: string;
}

export interface Community {
  heading: string;
  consult: CommunityEntry;
  blog: CommunityBlog;
}

export const COMMUNITY: Community = communityCatalog as Community;

/** The blog's own link, followed by the "ask for a topic" link into the channel. */
export function blogLinks(community: Community = COMMUNITY): ChoiceLink[] {
  return [community.blog.link, { label: community.blog.requestLinkLabel, url: community.consult.link.url }];
}
