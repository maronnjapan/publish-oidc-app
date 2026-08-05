import { readCsv } from "../../shared/csv";
import { MAX_USERS, PASSWORD_MAX_LENGTH, USERNAME_MAX_LENGTH } from "../../shared/rules";
import type { FormAction, FormState } from "../form-state";
import type { FormErrors } from "../validation";
import { FieldError, Hint } from "./Hints";
import { CsvPreviewTable } from "./CsvPreviewTable";

/**
 * The accounts the published OP will accept, typed in or read from a CSV.
 *
 * A CSV is never applied silently: it is parsed, every row gets a verdict in the preview
 * table, and only a file where every row passes replaces what is in the form.
 */
export function UsersCard({
  state,
  errors,
  dispatch,
}: {
  state: FormState;
  errors: FormErrors;
  dispatch: (action: FormAction) => void;
}) {
  async function onCsvSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    dispatch({ type: "csv-feedback", text: "CSVを確認しています…", error: false });
    try {
      const { entries, countError, usable } = readCsv(await file.text());
      dispatch({
        type: "preview-csv",
        preview: { fileName: file.name, entries, countError },
        feedback: usable
          ? { text: "", error: false }
          : {
              text: "CSVに修正が必要な項目があります。プレビューの判定欄を確認してください。",
              error: true,
            },
      });
      if (usable) {
        dispatch({
          type: "apply-csv",
          entries,
          feedback: {
            text: `${entries.length}件を登録予定のユーザー欄へ反映しました。内容を確認してからOPを作成してください。`,
            error: false,
          },
        });
      }
    } catch (error) {
      dispatch({
        type: "csv-feedback",
        text: `CSVを読み込めませんでした（${error instanceof Error ? error.message : String(error)}）`,
        error: true,
        clearPreview: true,
      });
    } finally {
      input.value = "";
    }
  }

  return (
    <section class="card">
      <div class="section-heading">
        <h2>登録予定のログインユーザー</h2>
        <span class="count" id="user-count">
          {state.users.length} / {MAX_USERS}件
        </span>
      </div>
      <div id="users">
        {state.users.map((user, index) => (
          <div class="user" key={user.id}>
            <div>
              <label class="block" for={`username-${user.id}`}>
                ユーザー名
              </label>
              <input
                id={`username-${user.id}`}
                class="username"
                type="text"
                required
                maxLength={USERNAME_MAX_LENGTH}
                autocomplete="username"
                value={user.username}
                onInput={(event) =>
                  dispatch({ type: "set-user", id: user.id, field: "username", value: event.currentTarget.value })
                }
              />
              <FieldError message={errors.users[index]?.username ?? ""} show={state.showErrors} />
            </div>
            <div>
              <label class="block" for={`password-${user.id}`}>
                パスワード
              </label>
              <input
                id={`password-${user.id}`}
                class="password"
                type="password"
                required
                maxLength={PASSWORD_MAX_LENGTH}
                autocomplete="new-password"
                value={user.password}
                onInput={(event) =>
                  dispatch({ type: "set-user", id: user.id, field: "password", value: event.currentTarget.value })
                }
              />
              <FieldError message={errors.users[index]?.password ?? ""} show={state.showErrors} />
            </div>
            <button
              type="button"
              class="danger"
              disabled={state.users.length <= 1}
              onClick={() => dispatch({ type: "remove-user", id: user.id })}
            >
              削除
            </button>
          </div>
        ))}
      </div>
      <div class="choices">
        <button
          class="secondary"
          id="add-user"
          type="button"
          disabled={state.users.length >= MAX_USERS}
          onClick={() => {
            if (state.users.length >= MAX_USERS) return;
            dispatch({ type: "add-user" });
            dispatch({
              type: "csv-feedback",
              text: `空のユーザー入力欄を追加しました。現在${state.users.length + 1}件です。`,
              error: false,
            });
          }}
        >
          ユーザーを追加
        </button>
        <label class="secondary file-button">
          CSVから読み込む
          <input class="sr" id="csv" type="file" accept=".csv,text/csv" onChange={onCsvSelected} />
        </label>
      </div>
      <p class={state.csvFeedback.error ? "hint error" : "hint"} id="csv-feedback" aria-live="polite">
        {state.csvFeedback.text}
      </p>
      <CsvPreviewTable preview={state.csv} />
      <FieldError message={errors.form} show={state.showErrors} />
      <Hint>
        ユーザー名は半角英数字と <code>. _ @ -</code> のみ（1〜{USERNAME_MAX_LENGTH}文字）、パスワードは
        {`8〜${PASSWORD_MAX_LENGTH}`}文字です。
      </Hint>
      <Hint>
        CSVは先頭行を <code>username,password</code> とし、合計{MAX_USERS}件まで指定できます。パスワードは共有D1へ個別salt付きSHA-256ハッシュとして保存します。
      </Hint>
    </section>
  );
}
