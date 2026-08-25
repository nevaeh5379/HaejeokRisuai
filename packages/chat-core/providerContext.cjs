'use strict';

function resolveRequestModel(request, settings) {
  let aiModel = request.staticModel || (
    request.mode === 'model' ? settings.primaryModel : settings.subModel
  );
  if (settings.separateModelsForAxModels && !request.staticModel) {
    const separateModel = settings.separateModels?.[request.mode];
    if (separateModel) aiModel = separateModel;
  }
  return aiModel;
}

function prepareProviderExecutionContext(request, settings, resolveModelInfo) {
  const aiModel = resolveRequestModel(request, settings);
  const modelInfo = { ...resolveModelInfo(aiModel) };
  let customURL;
  let key;

  if (aiModel === 'reverse_proxy') {
    modelInfo.internalID = settings.reverseProxy?.requestModel || '';
    modelInfo.format = settings.reverseProxy?.format ?? modelInfo.format;
    customURL = settings.reverseProxy?.url;
    key = settings.reverseProxy?.key;
  } else if (aiModel.startsWith('xcustom:::')) {
    const customModel = settings.customModels?.find((item) => item.id === aiModel);
    customURL = customModel?.url;
    key = customModel?.key;
  }

  return {
    aiModel,
    modelInfo,
    maxTokens: request.maxTokens ?? settings.maxResponseTokens,
    temperature: request.temperature ?? settings.temperaturePercent / 100,
    useStreaming: request.forceStreaming
      ? true
      : Boolean(settings.useStreaming && request.useStreaming),
    continue: request.continue ?? false,
    biasString: request.biasString ?? [],
    multiGen: settings.genTime > 1 && aiModel.startsWith('gpt') &&
      !request.continue && !request.noMultiGen,
    extractJson: request.extractJson ?? settings.extractJson,
    customURL,
    key,
    pluginBlocked: Boolean(request.blockPlugins && modelInfo.id?.startsWith('pluginmodel:::')),
  };
}

module.exports = { resolveRequestModel, prepareProviderExecutionContext };
