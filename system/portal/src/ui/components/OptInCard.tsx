import type { ComponentChildren } from "preact";
import type { CatalogFeature, OptInGroup } from "../../shared/catalog";
import type { FormAction, FormState } from "../form-state";
import { Hint } from "./Hints";

/**
 * The opt-in feature groups: the CLI's own stable-but-off-by-default features, and the
 * experimental package's. They share this component because they share a catalog shape;
 * only the framing around them differs, which is what the two cards below supply.
 *
 * A feature's sub-options stay disabled until the feature itself is on — selecting an option
 * of a feature that is not generated would silently do nothing.
 */
function FeatureToggles({
  group,
  features,
  state,
  dispatch,
}: {
  group: OptInGroup;
  features: CatalogFeature[];
  state: FormState;
  dispatch: (action: FormAction) => void;
}) {
  return (
    <>
      {features.map((feature) => {
        const selection = state.optIn[group][feature.id];
        return (
          <div class="opt-in-feature" key={feature.id}>
            <label class="opt-in-toggle">
              <input
                class={`${group}-toggle-input`}
                type="checkbox"
                value={feature.id}
                checked={selection.enabled}
                onChange={(event) =>
                  dispatch({ type: "toggle-opt-in", group, id: feature.id, value: event.currentTarget.checked })
                }
              />{" "}
              {feature.label}
            </label>
            <Hint links={feature.links}>
              {feature.spec} — {feature.summary}
            </Hint>
            {feature.endpoints.length > 0 ? (
              <Hint>
                追加されるエンドポイント: <code>{feature.endpoints.join(" / ")}</code>
              </Hint>
            ) : (
              <Hint>エンドポイントもDiscoveryメタデータも増えません。</Hint>
            )}
            {(feature.options ?? []).map((option) => (
              <div class="feature-option-row" key={option.id}>
                <label>
                  <input
                    class={`${group}-option`}
                    type="checkbox"
                    data-feature={feature.id}
                    data-option={option.id}
                    checked={selection.options[option.id] === true}
                    disabled={!selection.enabled}
                    onChange={(event) =>
                      dispatch({
                        type: "toggle-opt-in-option",
                        group,
                        id: feature.id,
                        option: option.id,
                        value: event.currentTarget.checked,
                      })
                    }
                  />{" "}
                  {option.label}
                </label>
                {option.hint || option.links ? <Hint links={option.links}>{option.hint ?? ""}</Hint> : null}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function OptInCard({
  group,
  features,
  state,
  dispatch,
  children,
}: {
  group: OptInGroup;
  features: CatalogFeature[];
  state: FormState;
  dispatch: (action: FormAction) => void;
  /** The framing the group needs around its toggles: a warning, or a folded summary. */
  children: (toggles: ComponentChildren) => ComponentChildren;
}) {
  if (features.length === 0) return null;
  return (
    <section class="card">
      {children(<FeatureToggles group={group} features={features} state={state} dispatch={dispatch} />)}
    </section>
  );
}
