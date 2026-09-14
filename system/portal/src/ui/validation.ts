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

export interface FormErrors {
  name: string;
  redirectUrl: string;
  users: UserErrors[];
  customScopes: string;
  /** A whole-form problem that no single field owns. */
  form: string;
  valid: boolean;
}

export function formErrors(state: FormState): FormErrors {
  const name = nameError(state.name);
  const redirectUrl = state.redirectUrl.trim() === "" ? REDIRECT_URL_HINTS.syntax : redirectUrlError(state.redirectUrl);
  const users = userErrors(state);
  const customScopes = customScopesError(state);
  const form = state.users.length < 1 ? NO_USERS_HINT : state.users.length > MAX_USERS ? CHECK_INPUT_HINT : "";
  const valid =
    !name && !redirectUrl && !customScopes && !form && users.every((entry) => !entry.username && !entry.password);
  return { name, redirectUrl, users, customScopes, form, valid };
}
