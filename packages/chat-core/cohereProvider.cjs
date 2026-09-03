"use strict";

const DEFAULT_COHERE_CHAT_URL = "https://api.cohere.com/v1/chat";
const COHERE_USER_MESSAGE_ERROR =
  "Cohere requires a user message to generate a response";

function prepareCohereConversation(messages, modelId) {
  const formated = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  let lastChatPrompt = "";
  let preamble = "";
  let lastChat = formated[formated.length - 1];

  if (lastChat?.role === "user") {
    lastChatPrompt = lastChat.content;
    formated.pop();
  } else {
    while (lastChat?.role !== "user") {
      lastChat = formated.pop();
      if (!lastChat) {
        return { ok: false, error: COHERE_USER_MESSAGE_ERROR };
      }
      lastChatPrompt =
        (lastChat.role === "user" ? "" : `${lastChat.role}: `) +
        "\n" +
        lastChat.content +
        lastChatPrompt;
    }
  }

  const firstChat = formated[0];
  if (firstChat?.role === "system") {
    preamble = firstChat.content;
    formated.shift();
  }

  const body = {
    message: lastChatPrompt,
    chat_history: formated
      .map((message) => {
        if (message.role === "assistant") {
          return { role: "CHATBOT", message: message.content };
        }
        if (message.role === "system") {
          return { role: "SYSTEM", message: message.content };
        }
        if (message.role === "user") {
          return { role: "USER", message: message.content };
        }
        return null;
      })
      .filter((message) => message?.message),
  };

  if (
    modelId !== "cohere-command-r-03-2024" &&
    modelId !== "cohere-command-r-plus-04-2024"
  ) {
    body.safety_mode = "NONE";
  }

  if (preamble) {
    if (body.chat_history.length > 0) {
      body.preamble = preamble;
    } else {
      body.message = `system: ${preamble}`;
    }
  }

  return { ok: true, body };
}

function decodeCohereResponse(ok, data) {
  if (!ok) {
    return { type: "fail", result: JSON.stringify(data) };
  }

  const result = data?.text;
  if (!result) {
    return { type: "fail", result: JSON.stringify(data) };
  }

  return { type: "success", result };
}

module.exports = {
  DEFAULT_COHERE_CHAT_URL,
  COHERE_USER_MESSAGE_ERROR,
  prepareCohereConversation,
  decodeCohereResponse,
};
