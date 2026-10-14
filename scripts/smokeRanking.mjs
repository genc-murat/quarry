/**
 * What a ranking smoke run has to show for itself, as rules over the probe's
 * steps — because the run itself needs a bundle, a GUI session and a live model,
 * and the judgement is the part that decides whether the run proved anything.
 *
 * Every rule here is a property of the app's behaviour rather than of the
 * model's: which table the model picks is the model's business, and only the
 * *fact* that its pick moved is the feature. The steps arrive as strings in
 * arrival order, which is what lets a *sequence* be asserted — the list opened in
 * the language's order, the question was in flight, the answer landed, the list
 * read differently afterwards — rather than a final state that would look the
 * same if the ranking had never happened.
 *
 * This file is rules only, so it can be checked without building anything: see
 * `smokeRanking.test.mjs`.
 */

/** The labels of a reported list step, top to bottom. */
export function listLabels(step) {
  return step.slice("list:".length).split("|");
}

/**
 * A run can also carry the failure phase, and it is judged the same way — as a
 * pair of steps rather than a final state: the app ran a statement the database
 * rejected, and a name appeared under the error once the local model had been
 * asked. `question.repair` says which SQL that was and which name a person would
 * act on; a run without it is judged on the ranking alone.
 */
export function problems(seen, question) {
  const { sql, typed, pick, repair } = question;
  const found = [];
  const steps = seen.steps.map((entry) => entry.step);
  const lists = seen.steps.filter((entry) => entry.step.startsWith("list:"));

  if (seen.finished === null) found.push("the probe never finished, so the run proves nothing");
  if (steps.some((step) => step.startsWith("error:"))) found.push(`the probe failed: ${steps.find((s) => s.startsWith("error:"))}`);
  if (steps.some((step) => step.startsWith("timeout:"))) found.push(`the probe gave up: ${steps.find((s) => s.startsWith("timeout:"))}`);
  if (!steps.some((step) => step.startsWith("connected:"))) found.push("the app never connected to the demo database");
  if (!steps.some((step) => step.startsWith("schema:"))) found.push("the editor's schema never loaded");

  // The one editor, with the SQL the run is about: a run that typed into some
  // other editor, or into one that cannot complete, would fail on the list
  // without saying why.
  const ready = steps.find((step) => step.startsWith("editor:ready:"));
  if (!ready) found.push("the editor never mounted");
  else {
    const [editors, sources] = ready.slice("editor:ready:".length).split(":").map(Number);
    if (editors !== 1) found.push(`${editors} editors were mounted: the run cannot say which one it typed into`);
    if (!(sources >= 1)) found.push("the editor offered no completion sources at the cursor");
  }
  const keystroke = steps.find((step) => step.startsWith(`typed:${typed}:`));
  if (!keystroke) found.push(`the probe never typed ${typed}`);
  else if (!keystroke.endsWith(sql + typed)) {
    found.push(`the keystroke did not land in ${sql}: the editor read “${keystroke.slice(-24)}”`);
  }

  if (lists.length === 0) found.push("the completion list never opened");
  if (lists.length > 0) {
    const first = listLabels(lists[0].step);
    const last = listLabels(lists[lists.length - 1].step);
    if (first[0] === pick) {
      found.push(`the list already led with ${pick}, so a reordering could not be seen`);
    }
    if (last[0] !== pick) {
      found.push(`the model's pick never reached the top: the list ended ${last.slice(0, 3).join(" > ")}`);
    }
  }

  // The ranking has to be the second thing that happened, not the first: a list
  // that opened already ranked would pass the order check on its own, and a
  // question reported after its answer is not a question anyone waited for.
  const ranked = steps.indexOf("assistant:ranked");
  const working = steps.indexOf("assistant:working");
  if (ranked < 0) found.push("the assistant never reported a ranked answer");
  if (working < 0) found.push("the question was never reported as in flight");
  else if (ranked >= 0 && working > ranked) found.push("the answer was reported before the question");

  // The failure phase, when the run asked for one. What it has to show is that the
  // statement failed at all, and that the name under the error is the one a person
  // would act on — a hint that never came is a failure of this phase, not a run
  // without one.
  if (repair) {
    const said = steps.findIndex((step) => step.startsWith("failed:"));
    const hint = steps.findIndex((step) => step.startsWith("repair:"));
    if (said < 0) found.push(`the app never reported a failure for ${repair.sql}`);
    const offered = hint >= 0 ? steps[hint].slice("repair:".length) : "";
    if (hint < 0) found.push("the editor never suggested a name for the failure");
    else {
      if (offered !== repair.name) {
        found.push(`the suggestion was ${offered}, not ${repair.name}`);
      }
      // The suggestion is the answer to a failure, so it cannot be reported before
      // the failure that was its question — and the run only reaches this phase
      // once the ranking has been seen.
      if (said >= 0 && hint < said) found.push("the suggestion was reported before the failure");
      if (ranked >= 0 && hint < ranked) {
        found.push("the failure was run before the ranking was seen");
      }
    }

    // And what acting on it does: the statement is rewritten in the editor and run.
    // A hint nobody can press, one that leaves the editor as it was, and a repaired
    // statement that fails anyway are three different faults. Only judged once a
    // suggestion was reported at all — a run that never got that far has already
    // said so above, and would otherwise be complained about twice for one fault.
    if (hint >= 0) {
      const written = steps.findIndex((step) => step.startsWith("fixed:"));
      const ran = steps.indexOf("ran:ok");
      if (steps.some((step) => step.startsWith("no-fix-button"))) {
        found.push("the editor offered no way to act on the suggestion");
      } else {
        // The editor has to hold the name the app *offered* rather than the name the
        // run wanted: whether that offer was right is the suggestion's own complaint,
        // and the promise the button makes is that it writes what it showed.
        if (written < 0) found.push("the suggestion was never written into the statement");
        else if (!steps[written].includes(offered)) {
          found.push(`the editor was left with ${steps[written]}, which does not hold ${offered}`);
        }
        if (ran < 0) found.push("the repaired statement was never run to a result");
        if (written >= 0 && ran >= 0 && ran < written) {
          found.push("the repaired statement ran before it was written");
        }
        if (written >= 0 && written < hint) {
          found.push("the repair was written before the suggestion was reported");
        }
      }
    }
  }
  return found;
}
