import choiceCatalog from "../../../../portal-choices.json";
import experimentalCatalog from "../../../../experimental-features.json";
import infra from "../../../../infra.json";
import optionalCatalog from "../../../../optional-features.json";

/**
 * The three catalog JSON files, typed and resolved once.
 *
 * They are the single source of truth for what the form offers and for the one-line summary
 * and reference links of every item, and they are imported by both bundles: the server
 * renders from them and the hydrating client renders from the same constants, so the two
 * trees cannot disagree. Changing a summary stays a data edit.
 */

/**
 * A reference for one selectable item. Both forms are optional and a choice may carry any
 * number of them: `url` for an external document (a spec, usually), `doc` for a Markdown
 * file in this repository. See docs/choices.md.
 */
export interface ChoiceLink {
  label: string;
  url?: string;
  doc?: string;
}

export interface CatalogOption {
  id: string;
  label: string;
  default?: boolean;
  hint?: string;
  links?: ChoiceLink[];
}

/** One entry of experimental-features.json or optional-features.json; the shape is shared. */
export interface CatalogFeature {
  id: string;
  status: string;
  label: string;
  spec: string;
  summary: string;
  endpoints: string[];
  options?: CatalogOption[];
  links?: ChoiceLink[];
}

/** One entry of portal-choices.json: a checkbox or select option plus its one-line summary. */
export interface ChoiceItem {
  id: string;
  label: string;
  summary: string;
  default?: boolean;
  required?: boolean;
  links?: ChoiceLink[];
}

export interface ChoiceGroup {
  id: string;
  label: string;
  items: ChoiceItem[];
}

/** The two opt-in groups share a shape but never share an id: the group decides the field. */
export type OptInGroup = "optional" | "experimental";

export const CHOICE_GROUPS: ChoiceGroup[] = choiceCatalog.groups as ChoiceGroup[];

// Only `supported` entries are wired into generated OPs, so only those are offered here.
export const EXPERIMENTAL_FEATURES: CatalogFeature[] = (experimentalCatalog.features as CatalogFeature[])
  .filter((feature) => feature.status === "supported");
export const OPTIONAL_FEATURES: CatalogFeature[] = (optionalCatalog.features as CatalogFeature[])
  .filter((feature) => feature.status === "supported");

export function choiceItems(groupId: string): ChoiceItem[] {
  const group = CHOICE_GROUPS.find((entry) => entry.id === groupId);
  if (!group) throw new Error(`portal-choices.json has no group ${JSON.stringify(groupId)}`);
  return group.items;
}

export function optInFeatures(group: OptInGroup): CatalogFeature[] {
  return group === "experimental" ? EXPERIMENTAL_FEATURES : OPTIONAL_FEATURES;
}

/**
 * `doc` links name a file in this repository rather than a URL, so a fork's portal points
 * at the fork's own copy: infra.json already carries the owner and repository the portal
 * dispatches its workflow to.
 */
export function linkHref(link: ChoiceLink): string | null {
  if (typeof link.url === "string" && link.url.startsWith("https://")) return link.url;
  if (typeof link.doc === "string" && link.doc.length > 0) {
    return `https://github.com/${infra.github_owner}/${infra.github_repo}/blob/main/${link.doc}`;
  }
  return null;
}

/** The links of one item that actually resolve, paired with their href. */
export function resolvedLinks(links: ChoiceLink[] | undefined): { link: ChoiceLink; href: string }[] {
  return (links ?? [])
    .map((link) => ({ link, href: linkHref(link) }))
    .filter((entry): entry is { link: ChoiceLink; href: string } => entry.href !== null);
}
