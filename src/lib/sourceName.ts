// Turn an imported source's stored filename/path into a readable label.
// Facebook exports arrive as paths like
//   "waylonwhite_10161249682556081/inbox/waylonwhite_10161249682556081/message_1.html"
// which should display as "waylonwhite". SMS thread files like
//   "threads/threads/Kelly Mann.txt" should display as "Kelly Mann".
export function cleanSourceName(filename: string): string {
  if (!filename) return "Untitled";
  const parts = filename.split(/[/\\]/).filter(Boolean);
  let name = parts[parts.length - 1] || filename;

  // Facebook: the conversation folder is the segment right before "inbox",
  // or the parent folder of a message_N.html file.
  const inboxIdx = parts.indexOf("inbox");
  if (inboxIdx > 0) {
    name = parts[inboxIdx - 1];
  } else if (parts.length > 1 && /^message_\d+\.html?$/i.test(name)) {
    name = parts[parts.length - 2];
  }

  name = name.replace(/\.(txt|html?|json|xml)$/i, "");   // drop extension
  name = name.replace(/_\d{6,}$/, "");                     // drop trailing FB id
  name = name.replace(/_/g, " ").trim();                   // underscores -> spaces
  return name || filename;
}
