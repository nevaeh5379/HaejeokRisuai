"use strict";

const GOOGLE_GENERATIVE_LANGUAGE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const GOOGLE_GENERATION_PARAMETER_RENAMES = Object.freeze({
  top_p: "topP",
  top_k: "topK",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  thinking_tokens: "thinkingBudget",
  reasoning_effort: "thinkingConfig.thinkingLevel",
});

function selectGoogleGenerationParameters(supportedParameters, options = {}) {
  const candidates = [
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "frequency_penalty",
  ];
  if (options.thinking) {
    candidates.push("thinking_tokens", "reasoning_effort");
  }
  return candidates.filter((parameter) =>
    supportedParameters.includes(parameter),
  );
}

function selectGoogleVertexRegion(modelId, configuredRegion) {
  // Gemini 3 preview models and the 3.5/3.6/3.7 Flash family are not served
  // from the regions exposed by the browser settings.
  if (
    /^gemini-3-.*-preview$/.test(modelId) ||
    /^gemini-3\.[567]-flash/.test(modelId)
  ) {
    return "global";
  }
  return configuredRegion;
}

function formatGoogleTextResponse(textParts, options = {}) {
  const thoughts = [];
  const content = [];
  for (const part of textParts) {
    const text = options.transformText
      ? options.transformText(part.text)
      : part.text;
    if (part.thought) {
      thoughts.push(text);
    } else {
      content.push(text);
    }
  }

  const thoughtText = thoughts.join("\n\n");
  const contentText = content.join("\n\n");
  return (
    (thoughtText ? `<Thoughts>\n\n${thoughtText}\n\n</Thoughts>\n\n` : "") +
    contentText
  );
}

function collectGoogleFunctionCalls(parts) {
  const calls = [];
  for (const part of parts) {
    if (part?.functionCall) calls.push(part.functionCall);
  }
  return calls;
}

function buildGoogleGenerateContentUrl(modelId, apiKey) {
  return `${GOOGLE_GENERATIVE_LANGUAGE_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
}

function prepareGoogleConversation(messages, options = {}) {
  const chats = [];
  let systemPrompt = "";
  let startIndex = 0;

  if (messages[0]?.role === "system") {
    systemPrompt = messages[0].content;
    startIndex = 1;
  }

  for (let index = startIndex; index < messages.length; index++) {
    const chat = messages[index];
    const previous = chats[chats.length - 1];

    if (chat.multimodals?.length) {
      const parts = [{ text: chat.content }];
      for (const modal of chat.multimodals) {
        const supported =
          (modal.type === "image" && options.hasImageInput) ||
          (modal.type === "audio" && options.hasAudioInput) ||
          (modal.type === "video" && options.hasVideoInput);
        if (supported) {
          const dataurl = modal.base64;
          const base64 = dataurl.split(",")[1];
          const mediaType = dataurl.split(";")[0].split(":")[1];
          parts.push({ inlineData: { mimeType: mediaType, data: base64 } });
          continue;
        }
        if (modal.type === "signature" && options.resolveSignature) {
          const signaturePart = options.resolveSignature(modal);
          if (signaturePart) parts.push(signaturePart);
        }
      }
      chats.push({
        role: chat.role === "user" ? "user" : "model",
        parts,
      });
      continue;
    }

    if (chat.role === "system") {
      if (previous?.role === "user") {
        previous.parts[0].text += `
system:${chat.content}`;
      } else {
        chats.push({
          role: "user",
          parts: [{ text: `${chat.role}:${chat.content}` }],
        });
      }
      continue;
    }

    if (chat.role === "assistant" || chat.role === "user") {
      chats.push({
        role: chat.role === "user" ? "user" : "model",
        parts: [{ text: chat.content }],
      });
      continue;
    }

    chats.push({
      role: "user",
      parts: [{ text: `${chat.role}:${chat.content}` }],
    });
  }

  return {
    chats,
    systemPrompt,
    consumedLeadingSystem: startIndex === 1,
  };
}

function finalizeGoogleGenerationConfig(generationConfig, options = {}) {
  if (options.thinking) {
    if (generationConfig.thinkingBudget !== undefined) {
      generationConfig.thinkingConfig = {
        thinkingBudget: generationConfig.thinkingBudget,
        includeThoughts: true,
      };
      delete generationConfig.thinkingBudget;
    } else if (generationConfig.thinkingConfig) {
      if (
        generationConfig.thinkingConfig.thinkingLevel === "minimal" &&
        options.thinkingNoMinimal
      ) {
        generationConfig.thinkingConfig.thinkingLevel = "low";
      }
      generationConfig.thinkingConfig.includeThoughts = true;
    }
  }

  let useStreaming = Boolean(options.useStreaming);
  if (options.hasAudioOutput) {
    generationConfig.responseModalities = ["TEXT", "AUDIO"];
    useStreaming = false;
  }
  if (options.imageResponse || options.hasImageOutput) {
    generationConfig.responseModalities = ["TEXT", "IMAGE"];
    useStreaming = false;
  }
  if (options.highMediaResolution) {
    generationConfig.mediaResolution = "MEDIA_RESOLUTION_MEDIUM";
  }

  return { generationConfig, useStreaming };
}

function buildGoogleSafetySettings(options = {}) {
  const threshold = options.blockOff ? "OFF" : "BLOCK_NONE";
  const categories = [
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
  ];
  if (options.includeCivicIntegrity !== false) {
    categories.push("HARM_CATEGORY_CIVIC_INTEGRITY");
  }
  return categories.map((category) => ({ category, threshold }));
}

function mergeGoogleConsecutiveChats(chats) {
  for (let index = chats.length - 1; index >= 1; index--) {
    const current = chats[index];
    const previous = chats[index - 1];
    if (current.role !== previous.role) continue;

    const previousLastPart = previous.parts[previous.parts.length - 1];
    const currentFirstPart = current.parts[0];
    if (previousLastPart?.text && currentFirstPart?.text) {
      previousLastPart.text += `\n\n${currentFirstPart.text}`;
      previous.parts.push(...current.parts.slice(1));
    } else {
      previous.parts.push(...current.parts);
    }
    chats.splice(index, 1);
  }
  return chats;
}

module.exports = {
  GOOGLE_GENERATIVE_LANGUAGE_BASE_URL,
  GOOGLE_GENERATION_PARAMETER_RENAMES,
  buildGoogleGenerateContentUrl,
  selectGoogleGenerationParameters,
  selectGoogleVertexRegion,
  formatGoogleTextResponse,
  collectGoogleFunctionCalls,
  prepareGoogleConversation,
  mergeGoogleConsecutiveChats,
  buildGoogleSafetySettings,
  finalizeGoogleGenerationConfig,
};
