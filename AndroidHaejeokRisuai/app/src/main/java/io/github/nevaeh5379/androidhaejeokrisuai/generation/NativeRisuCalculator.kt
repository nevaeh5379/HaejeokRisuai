package io.github.nevaeh5379.androidhaejeokrisuai.generation

internal object NativeRisuCalculator {
    private data class Operator(val precedence: Int, val rightAssociative: Boolean = false)

    private val operators = linkedMapOf(
        "+" to Operator(2), "-" to Operator(2),
        "*" to Operator(3), "/" to Operator(3), "%" to Operator(3),
        "^" to Operator(4), "<" to Operator(1), ">" to Operator(1),
        "|" to Operator(1), "&" to Operator(1),
        "≤" to Operator(1), "≥" to Operator(1),
        "=" to Operator(1), "≠" to Operator(1),
        "!" to Operator(5, rightAssociative = true),
    )

    fun calculate(expression: String, getVar: (String) -> String): Double {
        val expanded = expression.replace(Regex("\\$([a-zA-Z0-9_]+)")) { match ->
            getVar(match.groupValues[1]).toDoubleOrNull()?.toString() ?: "0"
        }.replace("&&", "&").replace("||", "|")
            .replace("<=", "≤").replace(">=", "≥")
            .replace("==", "=").replace("!=", "≠")
            .replace(Regex("null", RegexOption.IGNORE_CASE), "0")
        return calculateParentheses(expanded)
    }
    private fun calculateParentheses(text: String): Double {
        val depths = mutableListOf(StringBuilder())
        for (char in text) {
            when {
                char == '(' -> depths += StringBuilder()
                char == ')' && depths.size > 1 -> {
                    val result = execute(depths.removeAt(depths.lastIndex).toString())
                    depths.last().append(jsNumberString(result))
                }
                else -> depths.last().append(char)
            }
        }
        return execute(depths.joinToString("") { it.toString() })
    }

    private fun execute(text: String): Double {
        val rpn = toRpn(text.replace(Regex("\\s+"), ""))
        val stack = mutableListOf<Double>()
        for (token in rpn) {
            val number = token.toDoubleOrNull()
            if (number != null) stack += number else applyOperator(token, stack)
        }
        return stack.lastOrNull() ?: 0.0
    }
    private fun toRpn(expression: String): List<String> {
        val tokens = mutableListOf<String>()
        var current = ""
        for (index in expression.indices) {
            val char = expression[index]
            val unaryMinus = char == '-' && (index == 0 || expression[index - 1].toString() in operators || expression[index - 1] == '(')
            if (unaryMinus) current += char
            else if (char.toString() in operators) {
                tokens += current.ifEmpty { "0" }
                current = ""
                tokens += char.toString()
            } else current += char
        }
        tokens += current.ifEmpty { "0" }

        val output = mutableListOf<String>()
        val stack = mutableListOf<String>()
        for (token in tokens) {
            if (token.toDoubleOrNull() != null) output += token
            else if (token in operators) {
                val op = operators.getValue(token)
                while (stack.isNotEmpty()) {
                    val top = operators[stack.last()] ?: break
                    val shouldPop = if (op.rightAssociative) op.precedence < top.precedence else op.precedence <= top.precedence
                    if (!shouldPop) break
                    output += stack.removeAt(stack.lastIndex)
                }
                stack += token
            }
        }
        while (stack.isNotEmpty()) output += stack.removeAt(stack.lastIndex)
        return output
    }
    private fun applyOperator(token: String, stack: MutableList<Double>) {
        val b = if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else Double.NaN
        val a = if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) else Double.NaN
        stack += when (token) {
            "+" -> a + b
            "-" -> a - b
            "*" -> a * b
            "/" -> a / b
            "^" -> Math.pow(a, b)
            "%" -> a % b
            "<" -> if (a < b) 1.0 else 0.0
            ">" -> if (a > b) 1.0 else 0.0
            "≤" -> if (a <= b) 1.0 else 0.0
            "≥" -> if (a >= b) 1.0 else 0.0
            "=" -> if (a == b) 1.0 else 0.0
            "≠" -> if (a != b) 1.0 else 0.0
            "|" -> if (a != 0.0 && !a.isNaN()) a else b
            "&" -> if (a != 0.0 && !a.isNaN()) b else a
            "!" -> if (b != 0.0 && !b.isNaN()) 0.0 else 1.0
            else -> 0.0
        }
    }

    private fun jsNumberString(value: Double): String = when {
        value.isNaN() -> "NaN"
        value == Double.POSITIVE_INFINITY -> "Infinity"
        value == Double.NEGATIVE_INFINITY -> "-Infinity"
        value == 0.0 -> "0"
        value.isFinite() && value % 1.0 == 0.0 -> value.toLong().toString()
        else -> value.toString()
    }
}
