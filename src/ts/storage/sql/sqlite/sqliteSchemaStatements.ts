type QuoteMode = "single" | "double" | "backtick" | "bracket" | null;

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/**
 * Splits a SQLite schema into complete statements without treating semicolons
 * inside strings, comments, or CREATE TRIGGER ... BEGIN ... END bodies as
 * statement boundaries.
 */
export function splitSqliteStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: QuoteMode = null;
  let lineComment = false;
  let blockComment = false;
  let triggerStatement = false;
  let triggerBlockDepth = 0;
  let statementWords: string[] = [];
  const pushStatement = (end: number) => {
    const statement = sql.slice(start, end).trim();
    if (statement) statements.push(statement);
    start = end;
    triggerStatement = false;
    triggerBlockDepth = 0;
    statementWords = [];
  };

  const acceptWord = (word: string) => {
    const upper = word.toUpperCase();
    statementWords.push(upper);
    if (!triggerStatement && statementWords[0] === "CREATE") {
      triggerStatement =
        (statementWords.length === 2 && upper === "TRIGGER") ||
        (statementWords.length === 3 &&
          (statementWords[1] === "TEMP" || statementWords[1] === "TEMPORARY") &&
          upper === "TRIGGER");
    }
    if (!triggerStatement) return;
    if (upper === "BEGIN" || upper === "CASE") triggerBlockDepth++;
    else if (upper === "END" && triggerBlockDepth > 0) triggerBlockDepth--;
  };
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1] ?? "";

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      const close =
        quote === "single"
          ? "'"
          : quote === "double"
            ? '"'
            : quote === "backtick"
              ? "`"
              : "]";
      if (char === close) {
        if (quote !== "bracket" && next === close) i++;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "`") {
      quote = "backtick";
      continue;
    }
    if (char === "[") {
      quote = "bracket";
      continue;
    }

    if (/[A-Za-z_]/.test(char) && (i === 0 || !isWordChar(sql[i - 1]))) {
      let end = i + 1;
      while (end < sql.length && isWordChar(sql[end])) end++;
      acceptWord(sql.slice(i, end));
      i = end - 1;
      continue;
    }

    if (char === ";" && (!triggerStatement || triggerBlockDepth === 0)) {
      pushStatement(i + 1);
    }
  }

  pushStatement(sql.length);
  return statements;
}

export function isSqlitePragmaStatement(statement: string): boolean {
  const withoutLeadingTrivia = statement.replace(
    /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,
    "",
  );
  return /^PRAGMA\b/i.test(withoutLeadingTrivia);
}
