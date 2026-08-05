import type { Env } from "../../env";

/**
 * Starting the generation workflow. The portal never builds or deploys an OP itself: it
 * records the request and asks GitHub Actions to do the work, which is what keeps the
 * Cloudflare API token out of the Worker.
 */
export async function dispatchWorkflow(env: Env, inputs: Record<string, string>): Promise<boolean> {
  const url = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/generate-op.yml/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "maronn-oidc-portal",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
  return response.status === 204;
}
