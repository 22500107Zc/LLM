/**
 * Deterministic, clause-aware grading of an AI answer against expected facts.
 *
 * The previous implementation asked only "does every word of the concept appear
 * somewhere in the answer?". That passes three kinds of wrong answer:
 *
 *   concept "30 day refund"
 *     "Refunds are available within 30 days."      correct
 *     "Refunds are NOT available within 30 days."  contradicted - it passed
 *     "Refunds are available within 300 days."     wrong number - it passed
 *
 * This module fixes that without a second paid model call:
 *
 *   - Numbers are compared as whole tokens, so 30 never matches 300, and
 *     written forms are normalized ("thirty" -> 30, "30-day" -> 30).
 *   - A concept must be satisfied inside ONE clause. Words scattered across
 *     unrelated sentences no longer add up to a match.
 *   - Each clause carries a polarity. A positive expectation met by a negated
 *     clause is reported as contradicted, not as a pass.
 *   - When the clause matches on wording but carries a different number in the
 *     same role, that is reported as a numeric mismatch rather than a bare
 *     "missing concept", so the failure reason names the wrong fact.
 */

// ---------------------------------------------------------------- numbers --
const NUMBER_WORDS = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
});
const SCALE_WORDS = Object.freeze({
  hundred: 100,
  thousand: 1000,
  million: 1000000,
});

/**
 * Converts a run of number words into a value.
 * "twenty five" -> 25, "one hundred" -> 100, "thirty" -> 30.
 * @returns {number|null}
 */
function wordsToNumber(words) {
  if (!words.length) return null;
  let total = 0;
  let current = 0;
  let sawValue = false;

  for (const word of words) {
    if (word === "and") continue;
    if (NUMBER_WORDS[word] !== undefined) {
      current += NUMBER_WORDS[word];
      sawValue = true;
      continue;
    }
    if (SCALE_WORDS[word] !== undefined) {
      const scale = SCALE_WORDS[word];
      current = (current || 1) * scale;
      if (scale >= 1000) {
        total += current;
        current = 0;
      }
      sawValue = true;
      continue;
    }
    return null;
  }
  return sawValue ? total + current : null;
}

function isNumberWord(word) {
  return NUMBER_WORDS[word] !== undefined || SCALE_WORDS[word] !== undefined;
}

/**
 * Normalizes text into comparable tokens.
 * Digits stay digits; number words collapse into their numeric value; currency
 * and thousands separators are stripped so "$10,000" and "10000" agree.
 */
function tokenize(text) {
  const cleaned = String(text ?? "")
    .toLowerCase()
    // "30-day" and "30/day" must yield the number 30 as its own token.
    .replace(/[–—]/g, "-")
    .replace(/([0-9])[,](?=[0-9]{3}\b)/g, "$1")
    .replace(/[^\p{L}\p{N}%.$-]+/gu, " ")
    .replace(/(?<=\d)-(?=\D)|(?<=\D)-(?=\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const raw = cleaned.split(" ").filter(Boolean);
  const tokens = [];

  for (let i = 0; i < raw.length; i += 1) {
    let word = raw[i].replace(/^[$.]+|[.]+$/g, "");
    if (!word) continue;

    // A digit run, optionally with a decimal or percent sign.
    const numeric = word.match(/^(\d+(?:\.\d+)?)%?$/);
    if (numeric) {
      tokens.push({ kind: "number", value: Number(numeric[1]), text: word });
      continue;
    }

    // A run of number words collapses into one numeric token.
    if (isNumberWord(word)) {
      const run = [word];
      let j = i + 1;
      while (j < raw.length && (isNumberWord(raw[j]) || raw[j] === "and")) {
        run.push(raw[j]);
        j += 1;
      }
      const value = wordsToNumber(run);
      if (value !== null) {
        tokens.push({ kind: "number", value, text: run.join(" ") });
        i = j - 1;
        continue;
      }
    }

    tokens.push({ kind: "word", value: stem(word), text: word });
  }

  return tokens;
}

/** Light stemming so "refunds"/"refund" and "days"/"day" compare equal. */
function stem(word) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(word))
    return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

// ---------------------------------------------------------------- clauses --
/**
 * Words that carry no assertion and should not be required for a match.
 * Deliberately small: over-filtering would let vague answers pass.
 */
const FILLER = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "as",
  "that",
  "this",
  "it",
  "and",
  "or",
  "you",
  "your",
  "we",
  "our",
  "will",
  "can",
  "may",
]);

/** Markers that flip the polarity of the clause containing them. */
const NEGATORS = new Set([
  "not",
  "no",
  "never",
  "cannot",
  "cant",
  "wont",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
  "wasnt",
  "werent",
  "none",
  "neither",
  "nor",
  "without",
  "unavailable",
  "ineligible",
  "excluded",
  "prohibited",
  "denied",
  "refuse",
  "refused",
  "unable",
  "lack",
  "lacks",
  "except",
  "unless",
]);

/** Splits an answer into clauses so a match cannot span unrelated statements. */
function splitClauses(text) {
  return (
    String(text ?? "")
      // Sentence terminators, semicolons and contrastive conjunctions each end a
      // clause: "Refunds are available, but not after 30 days" is two claims.
      .split(
        /(?<=[.!?;])\s+|\s*[;]\s*|\s*,?\s+\b(?:but|however|although|though|whereas|except that)\b\s*/i
      )
      .map((clause) => clause.trim())
      .filter(Boolean)
  );
}

/** Normalizes a contraction so "don't" -> "dont" matches the negator list. */
function negationTokens(clause) {
  return String(clause)
    .toLowerCase()
    .replace(/[''`]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** @returns {boolean} true when the clause asserts the negative. */
function clauseIsNegated(clause) {
  const words = negationTokens(clause);
  // "not only ... but also" is emphasis, not negation.
  for (let i = 0; i < words.length; i += 1) {
    if (!NEGATORS.has(words[i])) continue;
    if (words[i] === "not" && words[i + 1] === "only") continue;
    return true;
  }
  return false;
}

// -------------------------------------------------------------- matching ---
/**
 * Evaluates one expected concept against the answer.
 * @returns {{status: string, reason: string, clause: string|null}}
 */
function evaluateConcept(concept, clauses) {
  const conceptTokens = tokenize(concept);
  const wanted = conceptTokens.filter(
    (t) => t.kind === "number" || !FILLER.has(t.value)
  );
  if (!wanted.length)
    return {
      status: "matched",
      reason: "No assertable content.",
      clause: null,
    };

  const wantedWords = wanted
    .filter((t) => t.kind === "word")
    .map((t) => t.value);
  const wantedNumbers = wanted
    .filter((t) => t.kind === "number")
    .map((t) => t.value);
  const conceptNegated = clauseIsNegated(concept);

  let bestPartial = null;

  for (const clause of clauses) {
    const tokens = tokenize(clause);
    const words = new Set(
      tokens.filter((t) => t.kind === "word").map((t) => t.value)
    );
    const numbers = tokens
      .filter((t) => t.kind === "number")
      .map((t) => t.value);

    const missingWords = wantedWords.filter((w) => !words.has(w));
    if (missingWords.length) continue; // wording does not belong to this clause

    const missingNumbers = wantedNumbers.filter((n) => !numbers.includes(n));
    const negated = clauseIsNegated(clause);

    if (!missingNumbers.length) {
      if (negated !== conceptNegated) {
        return {
          status: "contradicted",
          reason: conceptNegated
            ? `The answer asserts "${concept}" positively, but it was expected to be denied.`
            : `The answer denies "${concept}" ("${truncate(clause)}").`,
          clause,
        };
      }
      return { status: "matched", reason: "", clause };
    }

    // Right wording, wrong figure: name the number actually given.
    if (numbers.length) {
      bestPartial = {
        status: "numeric_mismatch",
        reason: `Expected ${missingNumbers.join(", ")} in "${concept}", but the answer states ${numbers.join(", ")} ("${truncate(clause)}").`,
        clause,
      };
      continue;
    }

    bestPartial = bestPartial ?? {
      status: "missing",
      reason: `"${concept}" is missing the value ${missingNumbers.join(", ")}.`,
      clause,
    };
  }

  return (
    bestPartial ?? {
      status: "missing",
      reason: `The answer does not state "${concept}".`,
      clause: null,
    }
  );
}

function truncate(text, max = 90) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Derives checkable concepts from a free-text expected answer: every number it
 * contains, together with the content words of the clause around that number,
 * plus the salient content words when it contains no numbers at all.
 */
function conceptsFromExpectedAnswer(expectedAnswer) {
  const clauses = splitClauses(expectedAnswer);
  const derived = [];

  for (const clause of clauses) {
    const tokens = tokenize(clause);
    const numbers = tokens.filter((t) => t.kind === "number");
    const words = tokens
      .filter((t) => t.kind === "word" && !FILLER.has(t.value))
      .map((t) => t.text);

    if (!numbers.length) continue;
    for (const number of numbers) {
      // Pair the figure with the two most specific words beside it so the
      // derived concept stays anchored to its clause.
      derived.push([number.text, ...words.slice(0, 2)].join(" "));
    }
  }

  if (derived.length) return derived;

  // No figures to key on: fall back to the longest content words, which is a
  // weaker check and is reported as such.
  const words = tokenize(expectedAnswer)
    .filter(
      (t) => t.kind === "word" && !FILLER.has(t.value) && t.text.length > 3
    )
    .map((t) => t.text);
  return [...new Set(words)].slice(0, 4).map((w) => w);
}

module.exports = {
  tokenize,
  stem,
  splitClauses,
  clauseIsNegated,
  evaluateConcept,
  conceptsFromExpectedAnswer,
  wordsToNumber,
  NEGATORS,
  FILLER,
};
