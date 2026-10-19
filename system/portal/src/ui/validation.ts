import {
  CUSTOM_SCOPE_MAX_LENGTH,
  MAX_CUSTOM_SCOPES,
  MAX_USERS,
  NAME_MAX_LENGTH,
  NAME_PATTERN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REDIRECT_URL_MAX_LENGTH,
  type RedirectUrlProblem,
  USERNAME_MAX_LENGTH,
  inspectRedirectUrl,
  isValidCustomScope,
  isValidPassword,
  isValidUsername,
} from "../shared/rules";
import { type OptInGroup, optInFeatures } from "../shared/catalog";
import { customScopeIds, type FormState } from "./form-state";

/**
 * The form's side of the shared rules: the same checks the Worker runs, phrased for the
 * person filling the form in. `shared/rules.ts` owns what is valid; this file owns how to
 * say it, so a rule change cannot leave the two ends disagreeing about the rule itself.
 */

export const USERNAME_HINT = `ユーザー名は半角英数字と . _ @ - のみ、1〜${USERNAME_MAX_LENGTH}文字で入力してください`;
export const PASSWORD_HINT = `パスワードは${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH}文字で入力してください`;
export const DUPLICATE_USERNAME_HINT = "同じユーザー名は複数登録できません";
export const NAME_HINT = `表示名は${NAME_MAX_LENGTH}文字以内で、改行や制御文字を含めずに入力してください`;
export const NO_USERS_HINT = "ログインユーザーを1件以上登録してください。";
export const CHECK_INPUT_HINT = "入力内容を確認してください。";
export const CUSTOM_SCOPES_HINT = `カスタムスコープは半角小文字英数字と . _ - のみ、1〜${CUSTOM_SCOPE_MAX_LENGTH}文字、カンマまたは空白区切りで${MAX_CUSTOM_SCOPES}件まで入力してください`;

const REDIRECT_URL_HINTS: Record<RedirectUrlProblem, string> = {
  syntax: "URLの形式が正しくありません（例: https://example.com/callback）",
  scheme: "httpsのURL、またはlocalhost・127.0.0.1のhttp URLを指定してください",
  credentials: "URLにユーザー名やパスワードを含めないでください",
  fragment: "URLに#以降のフラグメントを含めないでください",
  length: `URLは${REDIRECT_URL_MAX_LENGTH}文字以内で入力してください`,
};

/** Empty string means valid, so callers can render the result straight into the field. */
export function redirectUrlError(value: string): string {
  if (!value) return "";
  const result = inspectRedirectUrl(value.trim());
  return result.ok ? "" : REDIRECT_URL_HINTS[result.problem];
}

export function nameError(value: string): string {
  return NAME_PATTERN.test(value.trim()) ? "" : NAME_HINT;
}

export interface UserErrors {
  username: string;
  password: string;
}

/** One verdict per account row, in row order, so each row can render its own message. */
export function userErrors(state: FormState): UserErrors[] {
  const seen = new Set<string>();
  return state.users.map((user) => {
    const username = user.username.trim();
    let usernameError = "";
    if (!isValidUsername(username)) usernameError = USERNAME_HINT;
    else if (seen.has(username)) usernameError = DUPLICATE_USERNAME_HINT;
    seen.add(username);
    return { username: usernameError, password: isValidPassword(user.password) ? "" : PASSWORD_HINT };
  });
}

/** Empty string means valid, so callers can render the result straight into the field. */
export function customScopesError(state: FormState): string {
  const ids = customScopeIds(state);
  if (ids.length === 0) return "";
  if (ids.length > MAX_CUSTOM_SCOPES) return CUSTOM_SCOPES_HINT;
  return ids.every((id) => isValidCustomScope(id)) ? "" : CUSTOM_SCOPES_HINT;
}

const OPT_IN_GROUPS: OptInGroup[] = ["optional", "experimental", "extension"];

/** Key of one text option's error in FormErrors.optIn. */
export function optInErrorKey(group: OptInGroup, featureId: string, optionId: string): string {
  return `${group}.${featureId}.${optionId}`;
}

/**
 * Text options (google-login's client ID) are required once their feature is on, and must
 * match the pattern the catalog declares — the same pattern the Worker and the generator
 * enforce. Only enabled features are checked: a hidden, unticked field is not an error.
 */
export function optInErrors(state: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const group of OPT_IN_GROUPS) {
    for (const feature of optInFeatures(group)) {
      if (!state.optIn[group][feature.id]?.enabled) continue;
      for (const option of feature.options ?? []) {
        if (option.type !== "text") continue;
        const value = String(state.optIn[group][feature.id].options[option.id] ?? "").trim();
        if (value === "") errors[optInErrorKey(group, feature.id, option.id)] = `${option.label}を入力してください`;
        else if (!new RegExp(option.pattern ?? "").test(value)) {
          errors[optInErrorKey(group, feature.id, option.id)] = `${option.label}の形式が正しくありません${option.placeholder ? `（例: ${option.placeholder}）` : ""}`;
        }
      }
    }
  }
  return errors;
}

export interface FormErrors {
  name: string;
  redirectUrl: string;
  users: UserErrors[];
  customScopes: string;
  /** Text options of enabled opt-in features, keyed by optInErrorKey(). */
  optIn: Record<string, string>;
  /** A whole-form problem that no single field owns. */
  form: string;
  valid: boolean;
}

export function formErrors(state: FormState): FormErrors {
  const name = nameError(state.name);
  const redirectUrl = state.redirectUrl.trim() === "" ? REDIRECT_URL_HINTS.syntax : redirectUrlError(state.redirectUrl);
  const users = userErrors(state);
  const customScopes = customScopesError(state);
  const optIn = optInErrors(state);
  const form = state.users.length < 1 ? NO_USERS_HINT : state.users.length > MAX_USERS ? CHECK_INPUT_HINT : "";
  const valid =
    !name && !redirectUrl && !customScopes && !form && Object.keys(optIn).length === 0 && users.every((entry) => !entry.username && !entry.password);
  return { name, redirectUrl, users, customScopes, optIn, form, valid };
}
