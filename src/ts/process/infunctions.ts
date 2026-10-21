import { getChatVar, getGlobalChatVar } from "../parser/chatVar.svelte";

const OPERATORS: Record<
  string,
  { precedence: number; associativity: "Left" | "Right" }
> = {
  "+": { precedence: 2, associativity: "Left" },
  "-": { precedence: 2, associativity: "Left" },
  "*": { precedence: 3, associativity: "Left" },
  "/": { precedence: 3, associativity: "Left" },
  "^": { precedence: 4, associativity: "Left" },
  "%": { precedence: 3, associativity: "Left" },
  "<": { precedence: 1, associativity: "Left" },
  ">": { precedence: 1, associativity: "Left" },
  "|": { precedence: 1, associativity: "Left" },
  "&": { precedence: 1, associativity: "Left" },
  "≤": { precedence: 1, associativity: "Left" },
  "≥": { precedence: 1, associativity: "Left" },
  "=": { precedence: 1, associativity: "Left" },
  "≠": { precedence: 1, associativity: "Left" },
  "!": { precedence: 5, associativity: "Right" },
};
const OPERATOR_KEYS = new Set(Object.keys(OPERATORS));

function toRPN(expression: string) {
  let outputQueue = "";
  let operatorStack: string[] = [];

  expression = expression.replace(/\s+/g, "");
  let expression2: string[] = [];

  let lastToken = "";

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (
      char === "-" &&
      (i === 0 ||
        OPERATOR_KEYS.has(expression[i - 1]) ||
        expression[i - 1] === "(")
    ) {
      lastToken += char;
    } else if (OPERATOR_KEYS.has(char)) {
      if (lastToken !== "") {
        expression2.push(lastToken);
      } else {
        expression2.push("0");
      }
      lastToken = "";
      expression2.push(char);
    } else {
      lastToken += char;
    }
  }

  if (lastToken !== "") {
    expression2.push(lastToken);
  } else {
    expression2.push("0");
  }

  for (let i = 0; i < expression2.length; i++) {
    const token = expression2[i];
    if (parseFloat(token) || token === "0") {
      outputQueue += token + " ";
    } else if (OPERATOR_KEYS.has(token)) {
      while (
        operatorStack.length > 0 &&
        ((OPERATORS[token].associativity === "Left" &&
          OPERATORS[token].precedence <=
            OPERATORS[operatorStack[operatorStack.length - 1]].precedence) ||
          (OPERATORS[token].associativity === "Right" &&
            OPERATORS[token].precedence <
              OPERATORS[operatorStack[operatorStack.length - 1]].precedence))
      ) {
        outputQueue += operatorStack.pop() + " ";
      }

      operatorStack.push(token);
    }
  }

  while (operatorStack.length > 0) {
    outputQueue += operatorStack.pop() + " ";
  }

  return outputQueue.trim();
}

function calculateRPN(expression: string) {
  let stack: number[] = [];

  const tokens = expression.split(" ");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (parseFloat(token) || token === "0") {
      stack.push(parseFloat(token));
    } else {
      let [b, a] = [stack.pop(), stack.pop()];
      switch (token) {
        case "+":
          stack.push(a + b);
          break;
        case "-":
          stack.push(a - b);
          break;
        case "*":
          stack.push(a * b);
          break;
        case "/":
          stack.push(a / b);
          break;
        case "^":
          stack.push(a ** b);
          break;
        case "%":
          stack.push(a % b);
          break;
        case "<":
          stack.push(a < b ? 1 : 0);
          break;
        case ">":
          stack.push(a > b ? 1 : 0);
          break;
        case "|":
          stack.push(a || b);
          break;
        case "&":
          stack.push(a && b);
          break;
        case "≤":
          stack.push(a <= b ? 1 : 0);
          break;
        case "≥":
          stack.push(a >= b ? 1 : 0);
          break;
        case "=":
          stack.push(a === b ? 1 : 0);
          break;
        case "≠":
          stack.push(a !== b ? 1 : 0);
          break;
        case "!":
          stack.push(b ? 0 : 1);
          break;
      }
    }
  }

  if (stack.length === 0) {
    return 0;
  }

  return stack.pop();
}

function executeRPNCalculation(text: string) {
  text = text
    .replace(/\$([a-zA-Z0-9_]+)/g, (_, p1) => {
      const v = getChatVar(p1);
      const parsed = parseFloat(v);
      if (isNaN(parsed)) {
        return "0";
      }
      return parsed.toString();
    })
    .replace(/\@([a-zA-Z0-9_]+)/g, (_, p1) => {
      const v = getGlobalChatVar(p1);
      const parsed = parseFloat(v);
      if (isNaN(parsed)) {
        return "0";
      }
      return parsed.toString();
    })
    .replace(/&&/g, "&")
    .replace(/\|\|/g, "|")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/==/g, "=")
    .replace(/!=/g, "≠")
    .replace(/null/gi, "0");
  const expression = toRPN(text);
  const evaluated = calculateRPN(expression);
  return evaluated;
}

export function calcString(text: string) {
  let depthText: string[] = [""];

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") {
      depthText.push("");
    } else if (text[i] === ")" && depthText.length > 1) {
      let result = executeRPNCalculation(depthText.pop());
      depthText[depthText.length - 1] += result;
    } else {
      depthText[depthText.length - 1] += text[i];
    }
  }

  return executeRPNCalculation(depthText.join(""));
}
