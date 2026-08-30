use image::imageops::FilterType;
use image::{GenericImageView, ImageFormat};
use std::io::Cursor;

pub fn create_thumbnail_buffer(data: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(data).ok()?;
    let (orig_w, orig_h) = img.dimensions();

    // Scale to fill (cover), position top
    let aspect_orig = orig_w as f32 / orig_h as f32;
    let aspect_target = width as f32 / height as f32;

    let resized = if aspect_orig > aspect_target {
        // Source is wider: match height and crop width centered
        let new_w = (orig_w as f32 * (height as f32 / orig_h as f32)).round() as u32;
        let scaled = img.resize_exact(new_w, height, FilterType::Lanczos3);
        let crop_x = (new_w.saturating_sub(width)) / 2;
        scaled.crop_imm(crop_x, 0, width, height)
    } else {
        // Source is taller: match width and crop height from top (position top)
        let new_h = (orig_h as f32 * (width as f32 / orig_w as f32)).round() as u32;
        let scaled = img.resize_exact(width, new_h, FilterType::Lanczos3);
        scaled.crop_imm(0, 0, width, height)
    };

    let mut out = Cursor::new(Vec::new());
    if resized.write_to(&mut out, ImageFormat::WebP).is_ok() {
        Some(out.into_inner())
    } else {
        // Fallback to PNG if WebP encoding fails
        let mut png_out = Cursor::new(Vec::new());
        resized.write_to(&mut png_out, ImageFormat::Png).ok()?;
        Some(png_out.into_inner())
    }
}
