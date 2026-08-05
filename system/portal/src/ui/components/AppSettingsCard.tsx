import { choiceItems } from "../../shared/catalog";
import { NAME_MAX_LENGTH, REDIRECT_URL_MAX_LENGTH, type ClientType } from "../../shared/rules";
import type { FormAction, FormState } from "../form-state";
import type { FormErrors } from "../validation";
import { FieldError, Hint } from "./Hints";

/** Name, redirect URL and client type: the four fields every OP needs. */
export function AppSettingsCard({
  state,
  errors,
  dispatch,
}: {
  state: FormState;
  errors: FormErrors;
  dispatch: (action: FormAction) => void;
}) {
  const clientTypes = choiceItems("client-type");
  return (
    <section class="card">
      <h2>アプリ設定</h2>
      <div class="grid">
        <div>
          <label class="block" for="name">
            表示名（任意）
          </label>
          <input
            id="name"
            maxLength={NAME_MAX_LENGTH}
            autocomplete="off"
            value={state.name}
            onInput={(event) => dispatch({ type: "set-name", value: event.currentTarget.value })}
          />
          <FieldError message={errors.name} show={state.showErrors} />
        </div>
        <div>
          <label class="block" for="redirect-url">
            ログイン後のリダイレクトURL
          </label>
          <input
            id="redirect-url"
            type="url"
            required
            maxLength={REDIRECT_URL_MAX_LENGTH}
            placeholder="https://example.com/callback"
            value={state.redirectUrl}
            onInput={(event) => dispatch({ type: "set-redirect-url", value: event.currentTarget.value })}
          />
          <FieldError message={errors.redirectUrl} show={state.showErrors} />
        </div>
        <div>
          <label class="block" for="client-type">
            クライアント種別
          </label>
          <select
            id="client-type"
            value={state.clientType}
            onChange={(event) => dispatch({ type: "set-client-type", value: event.currentTarget.value as ClientType })}
          >
            {clientTypes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label class="block" for="template">
            テンプレート
          </label>
          <input id="template" value="Hono（固定）" disabled />
        </div>
      </div>
      {clientTypes.map((item) => (
        <Hint key={item.id} links={item.links}>
          <strong>{item.label}</strong>: {item.summary}
        </Hint>
      ))}
      <Hint>
        クライアントIDは自動発行されます。confidentialではクライアントシークレットも作成完了後に一度だけ表示します。
      </Hint>
      <Hint>
        リダイレクトURLはhttps（localhostと127.0.0.1のみhttp可）で指定し、#以降のフラグメントは含められません。表示名は
        {NAME_MAX_LENGTH}文字以内で日本語も使えます。
      </Hint>
    </section>
  );
}
