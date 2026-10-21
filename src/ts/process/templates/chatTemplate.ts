import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { Template } from "@huggingface/jinja";
import type { OpenAIChat } from "@risuai/chat-core/types.ts";
import type { character, groupChat } from "../../storage/database/schema";

import type { ChatExecutionTarget } from "src/ts/chatTarget";
import { getUserName } from "src/ts/util";

export const chatTemplates = {
  llama3:
    "{% set bos_token = '<|begin_of_text|>' %}{% set loop_messages = messages %}{% for message in loop_messages %}{% set content = '<|start_header_id|>' + message['role'] + '<|end_header_id|>\n\n'+ message['content'] | trim + '<|eot_id|>' %}{% if loop.index0 == 0 %}{% set content = bos_token + content %}{% endif %}{{ content }}{% endfor %}{{ '<|start_header_id|>assistant<|end_header_id|>\n\n' }}",
  llama2: `{% set bos_token = '<|begin_of_text|>' %}{% if messages[0]['role'] == 'system' %}{% set loop_messages = messages[1:] %}{% set system_message = messages[0]['content'] %}{% elif USE_DEFAULT_PROMPT == true and not '<<SYS>>' in messages[0]['content'] %}{% set loop_messages = messages %}{% set system_message = 'DEFAULT_SYSTEM_MESSAGE' %}{% else %}{% set loop_messages = messages %}{% set system_message = false %}{% endif %}{% for message in loop_messages %}{% if (message['role'] == 'user') != (loop.index0 % 2 == 0) %}{{ raise_exception('Conversation roles must alternate user/assistant/user/assistant/...') }}{% endif %}{% if loop.index0 == 0 and system_message != false %}{% set content = '<<SYS>>\n' + system_message + '\n<</SYS>>\n\n' + message['content'] %}{% else %}{% set content = message['content'] %}{% endif %}{% if message['role'] == 'user' %}{{ bos_token + '[INST] ' + content.strip() + ' [/INST]' }}{% elif message['role'] == 'system' %}{{ '<<SYS>>\n' + content.strip() + '\n<</SYS>>\n\n' }}{% elif message['role'] == 'assistant' %}{{ ' '  + content.strip() + ' ' + eos_token }}{% endif %}{% endfor %}`,
  chatml: `{% for message in messages %}{{'<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}`,
  gpt2: `{% for message in messages %}{{'<|im_start|>' + message['role'] + '\n' + message['content'] + '<|im_end|>' + '\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{% endif %}`,
  gemma:
    "{% if messages[0]['role'] == 'system' %}{{ raise_exception('System role not supported') }}{% endif %}{% for message in messages %}{% if (message['role'] == 'user') != (loop.index0 % 2 == 0) %}{{ raise_exception('Conversation roles must alternate user/assistant/user/assistant/...') }}{% endif %}{% if (message['role'] == 'assistant') %}{% set role = 'model' %}{% else %}{% set role = message['role'] %}{% endif %}{{ '<start_of_turn>' + role + '\n' + message['content'] | trim + '<end_of_turn>\n' }}{% endfor %}{% if add_generation_prompt %}{{'<start_of_turn>model\n'}}{% endif %}",
  mistral:
    "{% for message in messages %}{% if message['role'] == 'user' %}{{ ' [INST] ' + message['content'] + ' [/INST]' }}{% elif message['role'] == 'assistant' %}{{ ' ' + message['content'] + ' ' + eos_token}}{% else %}{{ raise_exception('Only user and assistant roles are supported!') }}{% endif %}{% endfor %}",
  vicuna:
    "{%- set ns = namespace(found=false) -%}\n{%- for message in messages -%}\n    {%- if message['role'] == 'system' -%}\n        {%- set ns.found = true -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- if not ns.found -%}\n    {{- '' + 'A chat between a curious user and an artificial intelligence assistant. The assistant gives helpful, detailed, and polite answers to the user\\'s questions.' + '\\n\\n' -}}\n{%- endif %}\n{%- for message in messages %}\n    {%- if message['role'] == 'system' -%}\n        {{- '' + message['content'] + '\\n\\n' -}}\n    {%- else -%}\n        {%- if message['role'] == 'user' -%}\n            {{-'USER: ' + message['content'] + '\\n'-}}\n        {%- else -%}\n            {{-'ASSISTANT: ' + message['content'] + '</s>\\n' -}}\n        {%- endif -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{-'ASSISTANT:'-}}\n{%- endif -%}",
  alpaca:
    "{%- set ns = namespace(found=false) -%}\n{%- for message in messages -%}\n    {%- if message['role'] == 'system' -%}\n        {%- set ns.found = true -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- if not ns.found -%}\n    {{- '' + 'Below is an instruction that describes a task. Write a response that appropriately completes the request.' + '\\n\\n' -}}\n{%- endif %}\n{%- for message in messages %}\n    {%- if message['role'] == 'system' -%}\n        {{- '' + message['content'] + '\\n\\n' -}}\n    {%- else -%}\n        {%- if message['role'] == 'user' -%}\n            {{-'### Instruction:\\n' + message['content'] + '\\n\\n'-}}\n        {%- else -%}\n            {{-'### Response:\\n' + message['content'] + '\\n\\n' -}}\n        {%- endif -%}\n    {%- endif -%}\n{%- endfor -%}\n{%- if add_generation_prompt -%}\n    {{-'### Response:\\n'-}}\n{%- endif -%}",
};
type TemplateEffect = "no_system_messages" | "alter_user_assistant_roles";
export const templateEffect = {
  gemma: ["no_system_messages"],
  mistral: ["no_system_messages", "alter_user_assistant_roles"],
} as { [key: string]: TemplateEffect[] };

const templateCache = new Map<string, Template>();
const MAX_TEMPLATE_CACHE_SIZE = 50;

function getOrCompileTemplate(key: string, source: string): Template {
  let template = templateCache.get(key);
  if (!template) {
    template = new Template(source);
    if (templateCache.size >= MAX_TEMPLATE_CACHE_SIZE) {
      const oldestKey = templateCache.keys().next().value;
      if (oldestKey !== undefined) {
        templateCache.delete(oldestKey);
      }
    }
    templateCache.set(key, template);
  }
  return template;
}

export const applyChatTemplate = (
  messages: OpenAIChat[],
  arg: {
    type?: string;
    custom?: string;
    currentChar?: character | groupChat;
    chatTarget?: ChatExecutionTarget;
  } = {},
) => {
  const currentChar = arg.currentChar ?? characterStore.currentCharacter;
  const type = arg.type ?? presetStore.state.instructChatTemplate;
  if (!type) {
    throw new Error("Template type is not set");
  }
  const templateSource =
    type === "jinja"
      ? (arg.custom ?? presetStore.state.JinjaTemplate)
      : chatTemplates[type as keyof typeof chatTemplates];
  if (!templateSource) {
    throw new Error(`Template not found for type: ${type}`);
  }
  const cacheKey =
    type === "jinja" ? `custom:${templateSource}` : `prebuilt:${type}`;
  const template = getOrCompileTemplate(cacheKey, templateSource);
  let formatedMessages: {
    role: "user" | "assistant" | "system";
    content: string;
  }[] = [];

  const effects = templateEffect[type] ?? [];
  const noSystemMessages = effects.includes("no_system_messages");
  const alterUserAssistantRoles = effects.includes(
    "alter_user_assistant_roles",
  );
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    let role = message.role;
    let content = message.content;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      continue;
    }
    if (noSystemMessages && role === "system") {
      role = "user";
      content = "System: " + content;
    }
    if (alterUserAssistantRoles) {
      if (role === "user") {
        if (formatedMessages.length % 2 === 0) {
          formatedMessages.push({
            role: "user",
            content,
          });
        } else {
          formatedMessages[formatedMessages.length - 1].content +=
            "\n" + content;
        }
      } else {
        if (
          formatedMessages.length % 2 === 1 ||
          formatedMessages.length === 0
        ) {
          if (formatedMessages.length === 0) {
            formatedMessages.push({
              role: "user",
              content: "",
            });
          }
          formatedMessages.push({
            role: "assistant",
            content,
          });
        } else {
          formatedMessages[formatedMessages.length - 1].content +=
            "\n" + content;
        }
      }
    } else {
      formatedMessages.push({
        role,
        content,
      });
    }
  }

  return template.render({
    messages: formatedMessages,
    add_generation_prompt: true,
    risu_char: currentChar.name,
    risu_user: getUserName(arg.chatTarget),
    eos_token: "",
    bos_token: "",
  });
};
