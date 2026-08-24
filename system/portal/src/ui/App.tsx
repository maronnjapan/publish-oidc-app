import { useEffect, useReducer, useState } from "preact/hooks";
import { EXPERIMENTAL_FEATURES, OPTIONAL_FEATURES, choiceItems } from "../shared/catalog";
import { type FeatureName, REQUIRED_SCOPE } from "../shared/rules";
import { formReducer, initialFormState, scopeDisabled } from "./form-state";
import { type PortalApi, browserApi } from "./api";
import { type Clock, createOp, loadQuota } from "./submit";
import { formErrors } from "./validation";
import { AppSettingsCard } from "./components/AppSettingsCard";
import { ChoiceCard } from "./components/ChoiceCard";
import { CommunityFooter } from "./components/CommunityFooter";
import { Hint } from "./components/Hints";
import { OptInCard } from "./components/OptInCard";
import { SubmitCard } from "./components/SubmitCard";
import { UsersCard } from "./components/UsersCard";

/**
 * The creation form.
 *
 * The same component tree renders on the Worker and hydrates in the browser, which is why it
 * takes no props with runtime data: everything it draws comes from the catalogs, which both
 * bundles import as build-time constants, and from `initialFormState()`, which is identical
 * on both sides. The quota — the one value that only exists at request time — is fetched
 * after hydration, so the server-rendered markup is exactly what the client first renders.
 */
export function App({ api = browserApi, clock }: { api?: PortalApi; clock?: Clock } = {}) {
  const [state, dispatch] = useReducer(formReducer, undefined, initialFormState);
  /**
   * The form is rendered before its script has run, and what a person types in that window
   * would not be in `state` — the first re-render after hydration would silently revert it.
   * So the controls arrive disabled and this turns them on, which cannot happen before the
   * reducer is the thing holding the answers.
   */
  const [ready, setReady] = useState(false);
  const errors = formErrors(state);

  useEffect(() => {
    setReady(true);
    void loadQuota(api, dispatch);
  }, [api]);

  return (
    <main>
      <header>
        <h1>OpenID Providerを作成</h1>
        <p>
          Honoと @maronn-openid-connect/core で構成した専用Cloudflare
          Workerを発行します。状態は共有D1へOPごとに分離して保存されます。
        </p>
      </header>
      <noscript>
        <p class="warning">この画面はJavaScriptで動作します。有効にすると入力欄が使えるようになります。</p>
      </noscript>
      <form
        id="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void createOp({ state, api, dispatch, clock });
        }}
      >
        <fieldset class="form-body" disabled={!ready} aria-busy={ready ? undefined : "true"}>
          <AppSettingsCard state={state} errors={errors} dispatch={dispatch} />

          <ChoiceCard
            group="scope"
            legend="スコープ"
            items={choiceItems("scope")}
            checked={(item) => item.id === REQUIRED_SCOPE || state.scopes[item.id] === true}
            disabled={(item) => scopeDisabled(state, item.id)}
            onToggle={(item, value) => dispatch({ type: "toggle-scope", id: item.id, value })}
          />

          <ChoiceCard
            group="feature"
            legend="OP機能"
            items={choiceItems("feature")}
            checked={(item) => state.features[item.id as FeatureName] === true}
            onToggle={(item, value) =>
              dispatch({
                type: "toggle-feature",
                id: item.id as FeatureName,
                value,
              })
            }
          >
            <Hint>publicクライアントはライブラリの安全ポリシーにより、PKCE設定をオフにしてもPKCEが必須です。</Hint>
          </ChoiceCard>

          <OptInCard group="optional" features={OPTIONAL_FEATURES} state={state} dispatch={dispatch}>
            {(toggles) => (
              <details class="optional">
                <summary>オプション機能（デフォルト無効・{OPTIONAL_FEATURES.length}件）</summary>
                <Hint>
                  仕様が要求していない範囲の堅牢化です。CLIが標準で持つ安定した機能なので試験的な機能とは別枠ですが、既定の生成物を「仕様どおり、それ以上でも以下でもない」状態に保つため既定では無効です。必要なときだけ有効にしてください。
                </Hint>
                {toggles}
              </details>
            )}
          </OptInCard>

          <OptInCard group="experimental" features={EXPERIMENTAL_FEATURES} state={state} dispatch={dispatch}>
            {(toggles) => (
              <fieldset>
                <legend>試験的な機能（@maronn-openid-connect/experimental）</legend>
                <p class="warning">
                  <strong>注意:</strong> ここは <code>@maronn-openid-connect/experimental</code> の機能です。
                  APIが安定しておらず、
                  <strong>他の機能より適切に動作しない可能性が高い</strong>
                  ため、動作検証にのみ使ってください。マイナーリリースでも破壊的変更や削除が起こり得ます。
                </p>
                {toggles}
              </fieldset>
            )}
          </OptInCard>

          <UsersCard state={state} errors={errors} dispatch={dispatch} />
          <SubmitCard state={state} />
        </fieldset>
      </form>
      <CommunityFooter />
    </main>
  );
}
