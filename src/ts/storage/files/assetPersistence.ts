export async function saveImage(data: Uint8Array, customId = "", fileName = "") {
  const { saveAsset } = await import("../../globalApi.svelte");
  return saveAsset(data, customId, fileName);
}
