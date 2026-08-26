export function escapeXml(text: string): string {
  return String(text).replace(/[&<>"'`=/]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
    "`": "&#x60;",
    "=": "&#x3D;",
    "/": "&#x2F;"
  })[character as "&" | "<" | ">" | "\"" | "'" | "`" | "=" | "/"]);
}
