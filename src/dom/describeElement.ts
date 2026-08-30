export function describeTarget(target: EventTarget | null): string {
  if (target === null) return "null";
  if (!(target instanceof Element)) return Object.prototype.toString.call(target);
  const tag = target.tagName.toLowerCase();
  const classes = [...target.classList].slice(0, 3).join(".");
  return classes ? `${tag}.${classes}` : tag;
}
