import type { LassoType, ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export function lassoOptions(
  preferences: ToolPreferences,
  selectType: (type: LassoType) => void,
  copyAll?: () => void
): DropdownOption[] {
  const labels: Record<LassoType, string> = {
    freeform: "Freeform Lasso",
    rectangle: "Square / Rectangle Lasso"
  };
  const options: DropdownOption[] = (["freeform", "rectangle"] as const).map((type) => ({
    id: type,
    label: labels[type],
    active: preferences.lasso.type === type,
    onSelect: () => selectType(type)
  }));
  if (copyAll) options.push({ id: "copy-all", label: "Copy All", onSelect: copyAll });
  return options;
}
