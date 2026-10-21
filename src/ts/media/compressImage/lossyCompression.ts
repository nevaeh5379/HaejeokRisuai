export async function doLossyCompression(
  imageData: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let objectUrl: string | null = null;
    let sourceSrc: string;

    if (
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      try {
        const blob = new Blob([imageData as any]);
        objectUrl = URL.createObjectURL(blob);
        sourceSrc = objectUrl;
      } catch {
        sourceSrc =
          "data:image/png;base64," + Buffer.from(imageData).toString("base64");
      }
    } else {
      sourceSrc =
        "data:image/png;base64," + Buffer.from(imageData).toString("base64");
    }

    const cleanup = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };

    const image = new Image();
    image.onload = () => {
      cleanup();
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Unable to get 2D context");
      }

      // Compute the new dimensions while maintaining aspect ratio
      let { width, height } = image;
      if (width > 3000 || height > 3000) {
        const aspectRatio = width / height;
        if (width > height) {
          width = 3000;
          height = Math.round(width / aspectRatio);
        } else {
          height = 3000;
          width = Math.round(height * aspectRatio);
        }
      }

      // Resize and draw the image to the canvas
      canvas.width = width;
      canvas.height = height;
      context.drawImage(image, 0, 0, width, height);

      // Try to convert to WebP (0.0 to 1.0 quality)
      let base64 = canvas.toDataURL("image/webp", 0.75);

      // If WebP is not supported, convert to JPEG
      if (base64.indexOf("data:image/webp") !== 0) {
        base64 = canvas.toDataURL("image/jpeg", 0.75);
      }

      const commaIndex = base64.indexOf(",");
      const b64Data = commaIndex >= 0 ? base64.slice(commaIndex + 1) : base64;
      const array = Buffer.from(b64Data, "base64");
      resolve(array);
    };

    image.onerror = (err) => {
      cleanup();
      reject(err);
    };

    image.src = sourceSrc;
  });
}
