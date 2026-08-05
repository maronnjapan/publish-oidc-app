import type { FormState } from "../form-state";
import { ResultPanel } from "./ResultPanel";

/** The remaining daily quota, the button, and whatever the creation is currently doing. */
export function SubmitCard({ state }: { state: FormState }) {
  const { quota, submission } = state;
  const exhausted = quota.loaded && !quota.failed && quota.remaining === 0;
  const quotaText = !quota.loaded
    ? "本日の残り作成回数を確認しています…"
    : quota.failed
      ? "本日の残り作成回数を取得できませんでした"
      : `本日の残り作成回数: ${quota.remaining} / ${quota.limit}（UTC日次リセット）`;

  return (
    <section class="card">
      <button class="primary" id="submit" type="submit" disabled={submission.phase === "busy" || exhausted}>
        OPを作成
      </button>
      <p id="quota" aria-live="polite">
        {quotaText}
      </p>
      <div id="status" aria-live="polite">
        {submission.phase === "done" ? (
          <ResultPanel url={submission.url} credentials={submission.credentials} enabled={submission.enabled} />
        ) : submission.phase === "idle" ? null : (
          submission.message
        )}
      </div>
    </section>
  );
}
