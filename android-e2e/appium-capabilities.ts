const DEFAULT_ANDROID_E2E_INFRASTRUCTURE_TIMEOUT_MS = 120_000;
const DEFAULT_ANDROID_E2E_CONNECTION_RETRY_TIMEOUT_MS = 180_000;

function readInfrastructureTimeout(): number {
  const value = Number(
    process.env.ANDROID_E2E_INFRASTRUCTURE_TIMEOUT_MS ??
      DEFAULT_ANDROID_E2E_INFRASTRUCTURE_TIMEOUT_MS,
  );
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_ANDROID_E2E_INFRASTRUCTURE_TIMEOUT_MS;
}

export function getAndroidE2eConnectionRetryTimeout(): number {
  const value = Number(
    process.env.ANDROID_E2E_CONNECTION_RETRY_TIMEOUT_MS ??
      DEFAULT_ANDROID_E2E_CONNECTION_RETRY_TIMEOUT_MS,
  );
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_ANDROID_E2E_CONNECTION_RETRY_TIMEOUT_MS;
}

export function getAndroidE2eInfrastructureCapabilities(): Record<
  string,
  number | boolean
> {
  const timeout = readInfrastructureTimeout();
  const skipDeviceInitialization =
    process.env.ANDROID_E2E_SKIP_DEVICE_INITIALIZATION === "1";

  return {
    "appium:adbExecTimeout": timeout,
    "appium:androidInstallTimeout": timeout,
    "appium:uiautomator2ServerInstallTimeout": timeout,
    "appium:uiautomator2ServerLaunchTimeout": timeout,
    ...(skipDeviceInitialization
      ? { "appium:skipDeviceInitialization": true }
      : {}),
  };
}
