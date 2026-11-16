import type { ComponentChildren } from "preact";
import type { CatalogFeature, OptInGroup } from "../../shared/catalog";
import type { FormAction, FormState } from "../form-state";
import { FieldError, Hint } from "./Hints";
import { optInErrorKey, type FormErrors } from "../validation";

/**
 * The opt-in feature groups: the CLI's own stable-but-off-by-default features, the
 * experimental package's, and the extension integrations. They share this component because
 * they share a catalog shape; only the framing around them differs, which is what the
 * card below supplies.
 *
 * A feature's sub-options stay disabled until the feature itself is on — selecting an option
 * of a feature that is not generated would silently do nothing.
 */
function FeatureToggles({
  group,
  features,
  state,
  errors,
  dispatch,
}: {
  group: OptInGroup;
  features: CatalogFeature[];
  state: FormState;
  errors: FormErrors;
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
            {(feature.options ?? []).map((option) =>
              option.type === "text" ? (
                <div class="feature-option-row" key={option.id}>
                  <label class="block" for={`${group}-${feature.id}-${option.id}`}>
                    {option.label}
                  </label>
                  <input
                    id={`${group}-${feature.id}-${option.id}`}
                    class={`${group}-option-text`}
                    type="text"
                    data-feature={feature.id}
                    data-option={option.id}
                    autocomplete="off"
                    spellcheck={false}
                    placeholder={option.placeholder}
                    value={String(selection.options[option.id] ?? "")}
                    disabled={!selection.enabled}
                    onInput={(event) =>
                      dispatch({
                        type: "toggle-opt-in-option",
                        group,
                        id: feature.id,
                        option: option.id,
                        value: event.currentTarget.value,
                      })
                    }
                  />
                  <FieldError
                    message={errors.optIn[optInErrorKey(group, feature.id, option.id)] ?? ""}
                    show={state.showErrors}
                  />
                  {option.hint || option.links ? <Hint links={option.links}>{option.hint ?? ""}</Hint> : null}
                </div>
              ) : (
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
              ),
            )}
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
  errors,
  dispatch,
  children,
}: {
  group: OptInGroup;
  features: CatalogFeature[];
  state: FormState;
  errors: FormErrors;
  dispatch: (action: FormAction) => void;
  /** The framing the group needs around its toggles: a warning, or a folded summary. */
  children: (toggles: ComponentChildren) => ComponentChildren;
}) {
  if (features.length === 0) return null;
  return (
    <section class="card">
      {children(<FeatureToggles group={group} features={features} state={state} errors={errors} dispatch={dispatch} />)}
    </section>
  );
}
