import type { Credentials, EnabledSummary } from "../form-state";

/**
 * The one and only time a client secret is shown. Everything here is held in browser memory
 * only: the Worker returns the credentials with the creation response and never stores the
 * secret past the deployment that installs it as a Worker secret.
 */
export function ResultPanel({
  url,
  credentials,
  enabled,
}: {
  url: string;
  credentials: Credentials;
  enabled: EnabledSummary;
}) {
  const fields: [string, string][] = [
    ["OP URL", url],
    ["クライアントID", credentials.clientId],
  ];
  if (credentials.clientSecret) fields.push(["クライアントシークレット", credentials.clientSecret]);
  return (
    <div class="result">
      <strong>OPを作成しました</strong>
      {fields.map(([label, value]) => (
        <div class="credential" key={label}>
          <span>{label}</span>
          <code>{value}</code>
        </div>
      ))}
      <p>
        {credentials.clientSecret
          ? "シークレットは再表示できません。今すぐ安全な場所へ保存してください。"
          : "publicクライアントのためシークレットは発行されません。"}
      </p>
      {enabled.optional.length > 0 ? <p>オプション機能を有効にしています（{enabled.optional.join(" / ")}）。</p> : null}
      {enabled.experimental.length > 0 ? (
        <p class="warning">
          試験的な機能を有効にしています（
          {enabled.experimental.map((entry) => `${entry.label}: ${entry.endpoints}`).join(" / ")}
          ）。@maronn-openid-connect/experimental はAPIが安定しておらず、他の機能より適切に動作しない可能性が高い点にご注意ください。
        </p>
      ) : null}
    </div>
  );
}
