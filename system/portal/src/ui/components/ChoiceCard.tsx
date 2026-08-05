import type { ChoiceItem } from "../../shared/catalog";
import type { ComponentChildren } from "preact";
import { Hint } from "./Hints";

/**
 * One catalog-driven checkbox group (scopes, OP features).
 *
 * `group` is both the catalog group id and the class the rows carry, so adding an item is a
 * catalog edit and nothing else. A `required` item renders checked and disabled: it is
 * always sent, and offering it as a choice would be a lie.
 */
export function ChoiceCard({
  group,
  legend,
  items,
  checked,
  disabled,
  onToggle,
  children,
}: {
  group: string;
  legend: string;
  items: ChoiceItem[];
  checked: (item: ChoiceItem) => boolean;
  disabled?: (item: ChoiceItem) => boolean;
  onToggle: (item: ChoiceItem, value: boolean) => void;
  children?: ComponentChildren;
}) {
  return (
    <section class="card">
      <fieldset>
        <legend>{legend}</legend>
        {items.map((item) => (
          <div class="choice" key={item.id}>
            <label>
              {item.required ? (
                <input type="checkbox" checked disabled />
              ) : (
                <input
                  class={group}
                  type="checkbox"
                  value={item.id}
                  checked={checked(item)}
                  disabled={disabled?.(item) ?? false}
                  onChange={(event) => onToggle(item, event.currentTarget.checked)}
                />
              )}{" "}
              {item.label}
              {item.required ? "（必須）" : ""}
            </label>
            <Hint links={item.links}>{item.summary}</Hint>
          </div>
        ))}
        {children}
      </fieldset>
    </section>
  );
}
