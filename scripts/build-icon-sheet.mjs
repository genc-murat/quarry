// Renders an HTML "icon sheet" so the generated app icon can be reviewed at the
// sizes that actually ship (dock, taskbar, tray). Output: icon-sheet.html
import { readFileSync, writeFileSync } from "node:fs";

const png = readFileSync("src-tauri/app-icon.png").toString("base64");
const uri = "data:image/png;base64," + png;

const sizes = [512, 256, 128, 64, 32];

function tiles() {
  return sizes
    .map(function (size) {
      return (
        '<div class="tile">' +
        '<img src="' + uri + '" width="' + size + '" height="' + size + '" alt="' + size + 'px">' +
        "<span>" + size + "px</span>" +
        "</div>"
      );
    })
    .join("\n      ");
}

function section(title, tone) {
  return (
    '<div class="' + tone + '">' +
    "<h1>" + title + "</h1>" +
    '<div class="row">\n      ' + tiles() + "\n    </div>" +
    "</div>"
  );
}

const html =
  '<!doctype html>\n<html><head><meta charset="utf-8"><title>Quarry icon sheet</title>\n' +
  "<style>\n" +
  "  body { margin: 0; font: 12px ui-sans-serif, system-ui, sans-serif; }\n" +
  "  .row { display: flex; align-items: flex-end; gap: 28px; padding: 28px; }\n" +
  "  .light { background: #f4f5f8; color: #1c1c22; }\n" +
  "  .dark  { background: #17171c; color: #e9e9ef; }\n" +
  "  .tile { display: flex; flex-direction: column; align-items: center; gap: 8px; }\n" +
  "  .tile img { display: block; }\n" +
  "  h1 { margin: 0; padding: 20px 28px 0; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; opacity: .6; }\n" +
  "</style></head>\n<body>\n" +
  "  " + section("Quarry — dark", "dark") + "\n" +
  "  " + section("Quarry — light", "light") + "\n" +
  "</body></html>\n";

writeFileSync("icon-sheet.html", html);
console.log("wrote icon-sheet.html (" + (html.length / 1024).toFixed(0) + " KB)");
