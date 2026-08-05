import {
  type CatalogFeature,
  type OptInGroup,
  EXPERIMENTAL_FEATURES,
  OPTIONAL_FEATURES,
  choiceItems,
} from "../shared/catalog";
import type { CsvEntry } from "../shared/csv";
import {
  type ClientType,
  FEATURE_NAMES,
  type FeatureName,
  MAX_USERS,
  REQUIRED_SCOPE,
} from "../shared/rules";
import type { CreateAppRequestBody } from "../shared/validation";

/**
 * The whole form as one value, changed only through the reducer below.
 *
 * Keeping it a plain reducer rather than scattered component state buys two things: the
 * server and the browser start from the same `initialFormState()`, so the hydrated tree
 * matches the rendered one exactly, and every rule that couples two controls (refresh
 * tokens and `offline_access`, a feature toggle and its options) is one testable function
 * instead of an event listener reaching across the document.
 */

export interface UserDraft {
  id: number;
  username: string;
  password: string;
}

export interface OptInState {
  enabled: boolean;
  options: Record<string, boolean>;
}

export interface CsvPreview {
  fileName: string;
  entries: CsvEntry[];
  countError: string;
}

export interface Credentials {
  clientId: string;
  clientSecret?: string;
}

export interface EnabledSummary {
  optional: string[];
  experimental: { label: string; endpoints: string }[];
}

/**
 * `busy` covers everything between pressing the button and knowing the outcome — sending,
 * polling, and retrying a status check that failed — because the form treats them the same:
 * the button stays disabled and the message under it says what is happening.
 */
export type Submission =
  | { phase: "idle" }
  | { phase: "busy"; message: string }
  | { phase: "done"; url: string; credentials: Credentials; enabled: EnabledSummary }
  | { phase: "error"; message: string };

export interface QuotaState {
  loaded: boolean;
  limit: number;
  remaining: number;
  failed: boolean;
}

export interface FormState {
  name: string;
  redirectUrl: string;
  clientType: ClientType;
  /** Optional scopes only; `openid` is always sent and is not a control. */
  scopes: Record<string, boolean>;
  features: Record<FeatureName, boolean>;
  optIn: Record<OptInGroup, Record<string, OptInState>>;
  users: UserDraft[];
  nextUserId: number;
  csv: CsvPreview | null;
  csvFeedback: { text: string; error: boolean };
  submission: Submission;
  quota: QuotaState;
  /** Set once the person has tried to submit, so errors are not shouted at an empty form. */
  showErrors: boolean;
}

function initialOptIn(features: CatalogFeature[]): Record<string, OptInState> {
  return Object.fromEntries(
    features.map((feature) => [
      feature.id,
      {
        enabled: false,
        options: Object.fromEntries((feature.options ?? []).map((option) => [option.id, option.default === true])),
      },
    ]),
  );
}

export function initialFormState(): FormState {
  const clientTypes = choiceItems("client-type");
  const scopeItems = choiceItems("scope").filter((item) => item.id !== REQUIRED_SCOPE);
  const featureItems = choiceItems("feature");
  return {
    name: "",
    redirectUrl: "",
    clientType: ((clientTypes.find((item) => item.default) ?? clientTypes[0]).id as ClientType),
    scopes: Object.fromEntries(scopeItems.map((item) => [item.id, item.default === true])),
    features: Object.fromEntries(
      FEATURE_NAMES.map((name) => [name, featureItems.find((item) => item.id === name)?.default === true]),
    ) as Record<FeatureName, boolean>,
    optIn: { optional: initialOptIn(OPTIONAL_FEATURES), experimental: initialOptIn(EXPERIMENTAL_FEATURES) },
    users: [{ id: 1, username: "", password: "" }],
    nextUserId: 2,
    csv: null,
    csvFeedback: { text: "", error: false },
    submission: { phase: "idle" },
    quota: { loaded: false, limit: 0, remaining: 0, failed: false },
    showErrors: false,
  };
}

export type FormAction =
  | { type: "set-name"; value: string }
  | { type: "set-redirect-url"; value: string }
  | { type: "set-client-type"; value: ClientType }
  | { type: "toggle-scope"; id: string; value: boolean }
  | { type: "toggle-feature"; id: FeatureName; value: boolean }
  | { type: "toggle-opt-in"; group: OptInGroup; id: string; value: boolean }
  | { type: "toggle-opt-in-option"; group: OptInGroup; id: string; option: string; value: boolean }
  | { type: "add-user" }
  | { type: "remove-user"; id: number }
  | { type: "set-user"; id: number; field: "username" | "password"; value: string }
  | { type: "preview-csv"; preview: CsvPreview; feedback: { text: string; error: boolean } }
  | { type: "apply-csv"; entries: CsvEntry[]; feedback: { text: string; error: boolean } }
  | { type: "csv-feedback"; text: string; error: boolean; clearPreview?: boolean }
  | { type: "set-quota"; quota: QuotaState }
  | { type: "set-submission"; submission: Submission }
  | { type: "show-errors" };

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "set-name":
      return { ...state, name: action.value };
    case "set-redirect-url":
      return { ...state, redirectUrl: action.value };
    case "set-client-type":
      return { ...state, clientType: action.value };
    case "toggle-scope":
      return { ...state, scopes: { ...state.scopes, [action.id]: action.value } };
    case "toggle-feature": {
      const features = { ...state.features, [action.id]: action.value };
      // Turning refresh tokens off takes offline_access with it: the Worker rejects the
      // combination, so the form must not be able to hold it.
      const scopes =
        action.id === "refresh-token" && !action.value ? { ...state.scopes, offline_access: false } : state.scopes;
      return { ...state, features, scopes };
    }
    case "toggle-opt-in": {
      const group = state.optIn[action.group];
      return {
        ...state,
        optIn: {
          ...state.optIn,
          [action.group]: { ...group, [action.id]: { ...group[action.id], enabled: action.value } },
        },
      };
    }
    case "toggle-opt-in-option": {
      const group = state.optIn[action.group];
      const feature = group[action.id];
      return {
        ...state,
        optIn: {
          ...state.optIn,
          [action.group]: {
            ...group,
            [action.id]: { ...feature, options: { ...feature.options, [action.option]: action.value } },
          },
        },
      };
    }
    case "add-user":
      if (state.users.length >= MAX_USERS) return state;
      return {
        ...state,
        users: [...state.users, { id: state.nextUserId, username: "", password: "" }],
        nextUserId: state.nextUserId + 1,
      };
    case "remove-user":
      if (state.users.length <= 1) return state;
      return { ...state, users: state.users.filter((user) => user.id !== action.id) };
    case "set-user":
      return {
        ...state,
        users: state.users.map((user) => (user.id === action.id ? { ...user, [action.field]: action.value } : user)),
      };
    case "preview-csv":
      return { ...state, csv: action.preview, csvFeedback: action.feedback };
    case "apply-csv":
      return {
        ...state,
        users: action.entries.map((entry, index) => ({
          id: state.nextUserId + index,
          username: entry.username,
          password: entry.password,
        })),
        nextUserId: state.nextUserId + action.entries.length,
        csvFeedback: action.feedback,
        showErrors: false,
      };
    case "csv-feedback":
      return {
        ...state,
        csv: action.clearPreview ? null : state.csv,
        csvFeedback: { text: action.text, error: action.error },
      };
    case "set-quota":
      return { ...state, quota: action.quota };
    case "set-submission":
      return { ...state, submission: action.submission };
    case "show-errors":
      return { ...state, showErrors: true };
    default:
      return state;
  }
}

/** `offline_access` is only selectable while the OP is generated with refresh tokens. */
export function scopeDisabled(state: FormState, scopeId: string): boolean {
  return scopeId === "offline_access" && !state.features["refresh-token"];
}

export function selectedScopes(state: FormState): string[] {
  return [
    REQUIRED_SCOPE,
    ...choiceItems("scope")
      .filter((item) => item.id !== REQUIRED_SCOPE && state.scopes[item.id])
      .map((item) => item.id),
  ];
}

export function selectedOptIn(state: FormState, group: OptInGroup): Record<string, Record<string, boolean>> {
  return Object.fromEntries(
    Object.entries(state.optIn[group])
      .filter(([, value]) => value.enabled)
      .map(([id, value]) => [id, value.options]),
  );
}

export function toRequestBody(state: FormState): CreateAppRequestBody {
  return {
    name: state.name.trim(),
    redirect_url: state.redirectUrl.trim(),
    client_type: state.clientType,
    scopes: selectedScopes(state),
    features: state.features,
    optional: selectedOptIn(state, "optional"),
    experimental: selectedOptIn(state, "experimental"),
    users: state.users.map((user) => ({ username: user.username.trim(), password: user.password })),
  };
}

/** What the completion panel repeats back about the opt-in features that were selected. */
export function enabledSummary(state: FormState): EnabledSummary {
  const labels = (group: OptInGroup, features: CatalogFeature[]) =>
    features.filter((feature) => state.optIn[group][feature.id]?.enabled);
  return {
    optional: labels("optional", OPTIONAL_FEATURES).map((feature) => feature.label),
    experimental: labels("experimental", EXPERIMENTAL_FEATURES).map((feature) => ({
      label: feature.label,
      endpoints: feature.endpoints.join(" / "),
    })),
  };
}
