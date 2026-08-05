import type { CsvPreview } from "../form-state";

/**
 * What the picked file actually contains, row by row, before any of it reaches the form.
 * Passwords are counted, never shown.
 */
export function CsvPreviewTable({ preview }: { preview: CsvPreview | null }) {
  if (!preview) return null;
  const { fileName, entries, countError } = preview;
  return (
    <div class="csv-preview" id="csv-preview">
      <p>
        <strong>CSVプレビュー: {fileName}</strong>（{entries.length}件）
      </p>
      {countError ? <p class="invalid">{countError}</p> : null}
      <table>
        <thead>
          <tr>
            <th>行</th>
            <th>ユーザー名</th>
            <th>パスワード</th>
            <th>判定</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => {
            const errors = countError ? [countError, ...entry.errors] : entry.errors;
            return (
              <tr key={index}>
                <td>{index + 1}</td>
                <td>{entry.username || "（未入力）"}</td>
                <td>{entry.password ? `入力あり（${entry.password.length}文字）` : "（未入力）"}</td>
                <td class={errors.length ? "invalid" : "valid"}>{errors.length ? errors.join(" / ") : "OK"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
