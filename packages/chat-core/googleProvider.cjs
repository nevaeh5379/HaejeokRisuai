'use strict';

const GOOGLE_GENERATIVE_LANGUAGE_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

function buildGoogleGenerateContentUrl(modelId, apiKey) {
  return `${GOOGLE_GENERATIVE_LANGUAGE_BASE_URL}/${modelId}:generateContent?key=${apiKey}`;
}

module.exports = {
  GOOGLE_GENERATIVE_LANGUAGE_BASE_URL,
  buildGoogleGenerateContentUrl,
};
