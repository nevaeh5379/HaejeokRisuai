'use strict';

function normalizeNodeProviderExecutionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Request body must be an object' };
  }
  if (!Number.isInteger(input.format) || input.format < 0 || input.format > 1000) {
    return { error: 'format must be an integer from 0 to 1000' };
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    return { error: 'payload must be an object' };
  }
  return {
    value: {
      format: input.format,
      payload: input.payload,
    },
  };
}

const normalizeNodeProviderTransportRequest = normalizeNodeProviderExecutionRequest;

module.exports = {
  normalizeNodeProviderExecutionRequest,
  normalizeNodeProviderTransportRequest,
};
