import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { statementAtCursor } from "@/lib/sqlScript";

/**
 * Visually marks the statement a Run would execute, so "run the statement
 * under the cursor" is never a guess (DBeaver highlights it the same way). The
 * selection, when there is one, is left to the editor's own selection styling.
 */
const activeStatementMark = Decoration.mark({ class: "cm-active-statement" });

function buildDecorations(view: EditorView): DecorationSet {
  const selection = view.state.selection.main;
  if (!selection.empty) return Decoration.none;

  const statement = statementAtCursor(view.state.doc.toString(), selection.head);
  if (!statement || statement.to <= statement.from) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  builder.add(statement.from, statement.to, activeStatementMark);
  return builder.finish();
}

/** Recompute the highlight whenever the text or the cursor moves. */
export function activeStatementHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (instance) => instance.decorations },
  );
}
